/**
 * AdaptadorAI - Módulo funcional para interação com modelos de IA (Google Generative AI)
 *
 * Encapsula a interação com a API, incluindo cache, rate limiting,
 * tratamento de erros, circuit breaker e processamento de diferentes tipos de mídia.
 * Adere aos princípios de programação funcional com lodash/fp.
 */

const _ = require('lodash/fp');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const crypto = require('crypto');
const fs = require('fs').promises; // Usar fs.promises
const path = require('path');
const NodeCache = require('node-cache');
const Bottleneck = require('bottleneck');
const {
  obterInstrucaoPadrao,
  obterInstrucaoAudio,
  obterInstrucaoImagem,
  obterInstrucaoDocumento,
  obterPromptVideoLegenda,
  obterInstrucaoImagemCurta
} = require('../../config/InstrucoesSistema');
const { salvarConteudoBloqueado } = require('../../utilitarios/ArquivoUtils');
const { Resultado } = require('../../utilitarios/Ferrovia');

// --- Constantes e Configurações ---
const DEFAULT_MODEL = "gemini-2.0-flash";
const CACHE_TTL_SEGUNDOS = 3600; // 1 hora
const CACHE_MAX_ENTRADAS = 500;
const RATE_LIMITER_MAX_CONCORRENTE = 20;
const RATE_LIMITER_MIN_TEMPO_MS = 1000 / 30; // Aproximadamente 30 QPM (ajustar conforme necessário)
const TIMEOUT_API_GERAL_MS = 90000; // 90 segundos
const TIMEOUT_API_UPLOAD_MS = 180000; // 3 minutos para uploads/processamento de arquivos
const MAX_TENTATIVAS_API = 5;
const TEMPO_ESPERA_BASE_MS = 5000;
const CIRCUIT_BREAKER_LIMITE_FALHAS = 5;
const CIRCUIT_BREAKER_TEMPO_RESET_MS = 60000; // 1 minuto

// --- Funções Utilitárias Puras ---

/**
 * Gera um hash SHA256 para uma string ou buffer.
 * @param {string|Buffer} data - Dados para hash.
 * @returns {string} Hash SHA256 em hexadecimal.
 */
const gerarHash = (data) => crypto.createHash('sha256').update(data || '').digest('hex');

/**
 * Limpa e formata a resposta da IA.
 * @param {string} texto - Texto para limpar.
 * @returns {string} Texto limpo.
 */
const limparResposta = _.pipe(
  _.toString, // Garante que é string
  _.replace(/^(?:amélie|amelie):[\s]*/gi, ''), // Remove prefixo
  // Remover Markdown
  _.replace(/[*_]/g, ''), // Remove asteriscos e underscores (simplificado)
  _.replace(/^#+\s*/gm, ''), // Remove cabeçalhos (#)
  _.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), // Remove links, mantém texto
  _.replace(/^[-*]\s+/gm, ''), // Remove marcadores de lista (- *)
  // Fim da remoção de Markdown
  _.replace(/\r\n|\r|\n{2,}/g, '\n\n'), // Normaliza novas linhas (mantém duplas)
  _.trim
);

/**
 * Cria uma chave de cache consistente para uma requisição.
 * @param {string} tipo - Tipo de processamento ('texto', 'imagem', 'audio', 'documentoInline', 'documentoArquivo', 'video').
 * @param {Object} payload - Dados da requisição (texto, prompt, dadosAnexo, caminhoArquivo, etc.).
 * @param {Object} config - Configurações da IA.
 * @returns {Promise<string>} Chave de cache.
 */
const criarChaveCache = async (tipo, payload, config) => {
  const configHash = gerarHash(JSON.stringify({
    model: config.model || DEFAULT_MODEL,
    temperature: config.temperature,
    topK: config.topK,
    topP: config.topP,
    maxOutputTokens: config.maxOutputTokens,
    // Corrigido para usar 'systemInstructions' (plural) que vem da config preparada
    systemInstructions: config.systemInstructions // Inclui instrução no hash
  }));

  let conteudoHash;
  switch (tipo) {
    case 'texto':
      conteudoHash = gerarHash(payload.texto);
      break;
    case 'imagem':
    case 'audio':
    case 'documentoInline':
      conteudoHash = gerarHash(payload.dadosAnexo.data + (payload.prompt || ''));
      break;
    case 'documentoArquivo':
    case 'video':
      try {
        const fileBuffer = await fs.readFile(payload.caminhoArquivo);
        conteudoHash = gerarHash(fileBuffer + (payload.prompt || ''));
      } catch (err) {
        // Se não puder ler o arquivo, não pode cachear baseado no conteúdo
        conteudoHash = gerarHash(payload.caminhoArquivo + (payload.prompt || '')); // Fallback para path
      }
      break;
    default:
      conteudoHash = 'tipo_desconhecido';
  }

  return `${tipo}_${conteudoHash}_${configHash}`;
};

// --- Lógica do Circuit Breaker (Funcional) ---

const estadoInicialCircuitBreaker = () => ({
  falhas: 0,
  ultimaFalha: 0,
  estado: 'FECHADO', // FECHADO, ABERTO, SEMI_ABERTO
});

const registrarSucessoCB = (estadoCB) => ({
  ...estadoCB,
  falhas: 0,
  estado: 'FECHADO',
});

const registrarFalhaCB = (estadoCB) => {
  const novoEstado = { ...estadoCB, falhas: estadoCB.falhas + 1, ultimaFalha: Date.now() };
  if (novoEstado.falhas >= CIRCUIT_BREAKER_LIMITE_FALHAS) {
    novoEstado.estado = 'ABERTO';
  }
  return novoEstado;
};

const podeExecutarCB = (estadoCB) => {
  if (estadoCB.estado === 'FECHADO') return { podeExecutar: true, novoEstado: estadoCB };
  if (estadoCB.estado === 'ABERTO') {
    if (Date.now() - estadoCB.ultimaFalha > CIRCUIT_BREAKER_TEMPO_RESET_MS) {
      // Transição para SEMI_ABERTO ao tentar executar
      return { podeExecutar: true, novoEstado: { ...estadoCB, estado: 'SEMI_ABERTO' } };
    }
    return { podeExecutar: false, novoEstado: estadoCB };
  }
  // No estado SEMI_ABERTO, permite a execução (o resultado atualizará o estado)
  return { podeExecutar: true, novoEstado: estadoCB };
};

// --- Fábrica do Adaptador AI ---

/**
 * Cria a instância funcional do gerenciador de IA.
 * @param {Object} dependencias - Objeto com dependências (registrador, apiKey).
 * @returns {Object} Objeto com as funções de processamento da IA.
 */
const criarAdaptadorAI = (dependencias) => {
  const { registrador, apiKey } = dependencias;

  if (!registrador || !apiKey) {
    throw new Error("Dependências 'registrador' e 'apiKey' são obrigatórias para criarAdaptadorAI.");
  }

  // --- Inicialização de Estado e Clientes ---
  const genAI = new GoogleGenerativeAI(apiKey);
  const gerenciadorArquivosGoogle = new GoogleAIFileManager(apiKey);
  const cacheRespostas = new NodeCache({
    stdTTL: CACHE_TTL_SEGUNDOS,
    checkperiod: CACHE_TTL_SEGUNDOS * 0.2, // Verifica expiração periodicamente
    maxKeys: CACHE_MAX_ENTRADAS,
    useClones: false // Para performance, assumindo que não modificamos o cacheado
  });
  const rateLimiter = new Bottleneck({
    maxConcurrent: RATE_LIMITER_MAX_CONCORRENTE,
    minTime: RATE_LIMITER_MIN_TEMPO_MS
  });
  let estadoCB = estadoInicialCircuitBreaker(); // Estado mutável do circuit breaker

  // Cache para instâncias de modelo (evita recriar para mesma config)
  const cacheModelos = new NodeCache({ stdTTL: 3600, maxKeys: 50, useClones: false });

  // --- Funções Internas (com acesso ao closure) ---

  /**
   * Obtém ou cria um modelo generativo com cache.
   */
  const obterOuCriarModelo = (config) => {
    const configModelo = {
      model: config.model || DEFAULT_MODEL,
      generationConfig: _.pick(['temperature', 'topK', 'topP', 'maxOutputTokens'], config),
      safetySettings: config.safetySettings || [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ],
      // Corrigido para usar 'systemInstructions' (plural) que vem de FilasConfiguracao
      systemInstruction: config.systemInstructions || obterInstrucaoPadrao()
    };

    const chaveCacheModelo = gerarHash(JSON.stringify(configModelo));

    if (cacheModelos.has(chaveCacheModelo)) {
      registrador.debug(`Usando modelo em cache: ${chaveCacheModelo}`);
      return cacheModelos.get(chaveCacheModelo);
    }

    registrador.debug(`Criando novo modelo: ${chaveCacheModelo}`);
    const novoModelo = genAI.getGenerativeModel(configModelo);
    cacheModelos.set(chaveCacheModelo, novoModelo);
    return novoModelo;
  };

  /**
   * Executa uma função que interage com a API Gemini, aplicando retries, timeout e circuit breaker.
   */
  const executarComResiliencia = async (nomeOperacao, funcaoApi, timeoutMs = TIMEOUT_API_GERAL_MS) => {
    let tentativas = 0;
    while (tentativas < MAX_TENTATIVAS_API) {
      const { podeExecutar, novoEstado } = podeExecutarCB(estadoCB);
      estadoCB = novoEstado; // Atualiza estado (SEMI_ABERTO)

      if (!podeExecutar) {
        const erroCB = new Error("Serviço de IA temporariamente indisponível (Circuit Breaker).");
        registrador.warn(`[${nomeOperacao}] Circuit Breaker ABERTO. Requisição bloqueada.`);
        return Resultado.falha(erroCB); // Retorna falha
      }

      try {
        const promessaResultado = rateLimiter.schedule(() => funcaoApi());
        const promessaTimeout = new Promise((_, reject) =>
          // Criar um erro específico para timeout
          setTimeout(() => reject(new Error(`Timeout da API Gemini (${timeoutMs}ms) em ${nomeOperacao}`)), timeoutMs)
        );

        const resultadoApi = await Promise.race([promessaResultado, promessaTimeout]);

        // Sucesso: atualiza CB e retorna Resultado.sucesso
        estadoCB = registrarSucessoCB(estadoCB);
        return Resultado.sucesso(resultadoApi);

      } catch (erro) {
        tentativas++;
        registrador.warn(`[${nomeOperacao}] Erro na tentativa ${tentativas}/${MAX_TENTATIVAS_API}: ${erro.message}`);

        // Registrar falha no CB
        const estadoAnterior = estadoCB.estado;
        estadoCB = registrarFalhaCB(estadoCB);
        if (estadoCB.estado === 'ABERTO' && estadoAnterior !== 'ABERTO') {
           registrador.error(`[${nomeOperacao}] Circuit Breaker ABERTO após falha!`);
        }

        // Lógica de Retry (Backoff Exponencial)
        // Verifica se é um erro que justifica retentativa
        const ehErroRetry = erro.message.includes('503') || erro.message.includes('UNAVAILABLE') || erro.message.includes('Timeout');

        if (tentativas < MAX_TENTATIVAS_API && ehErroRetry) {
          const tempoEsperaAtual = TEMPO_ESPERA_BASE_MS * Math.pow(2, tentativas - 1);
          registrador.info(`[${nomeOperacao}] Aguardando ${tempoEsperaAtual}ms antes da próxima tentativa...`);
          await new Promise(resolve => setTimeout(resolve, tempoEsperaAtual));
          continue; // Próxima iteração do while
        }

        // Se não for erro de retry ou excedeu tentativas, retorna Resultado.falha com o último erro
        registrador.error(`[${nomeOperacao}] Falha definitiva após ${tentativas} tentativas: ${erro.message}`);
        return Resultado.falha(erro);
      }
    }
    // Se saiu do loop (excedeu tentativas), retorna falha
    const erroMaxTentativas = new Error(`[${nomeOperacao}] Falha após ${MAX_TENTATIVAS_API} tentativas.`);
    return Resultado.falha(erroMaxTentativas);
  };

  /**
   * Processa a resposta da IA, tratando erros de safety e respostas vazias.
   */
  const processarRespostaIA = (resultadoApi, tipoConteudo, dadosOrigem) => {
    const origemInfo = dadosOrigem ? `[Origem: ${dadosOrigem.tipo} "${dadosOrigem.nome}" (${dadosOrigem.id})]` : '[Origem desconhecida]';

    // Verificar safety blocks na resposta
    if (resultadoApi.response?.promptFeedback?.blockReason) {
      const blockReason = resultadoApi.response.promptFeedback.blockReason;
      const erroSafety = new Error(`Conteúdo bloqueado por SAFETY (promptFeedback): ${blockReason}`);
      registrador.warn(`⚠️ ${erroSafety.message} ${origemInfo}`);
      return Resultado.falha(erroSafety); // Retorna falha
    }
    if (resultadoApi.response?.candidates?.[0]?.finishReason === 'SAFETY') {
      const safetyRatings = resultadoApi.response?.candidates?.[0]?.safetyRatings;
      const erroSafety = new Error("Conteúdo bloqueado por SAFETY (finishReason)");
      registrador.warn(`⚠️ ${erroSafety.message}. Ratings: ${JSON.stringify(safetyRatings)} ${origemInfo}`);
      return Resultado.falha(erroSafety); // Retorna falha
    }

    const textoResposta = resultadoApi.response?.text();

    if (!textoResposta || typeof textoResposta !== 'string' || textoResposta.trim() === '') {
      const erroVazio = new Error(`Resposta vazia ou inválida da IA para ${tipoConteudo}.`);
      registrador.warn(`[AdpAI] ${erroVazio.message} ${origemInfo}`);
      return Resultado.falha(erroVazio); // Retorna falha
    }

    // Sucesso: retorna o texto limpo dentro de Resultado.sucesso
    return Resultado.sucesso(limparResposta(textoResposta));
  };

  /**
   * Trata erros específicos da API, incluindo safety e erros gerais.
   */
  const tratarErroAPI = (erro, tipoConteudo, dadosOrigem, infoExtra = {}) => {
    const origemInfo = dadosOrigem ? `[Origem: ${dadosOrigem.tipo} "${dadosOrigem.nome}" (${dadosOrigem.id})]` : '[Origem desconhecida]';
    const erroMsg = erro.message || 'Erro desconhecido';

    // Logar o erro sempre
    registrador.error(`[AdpAI] Erro ao processar ${tipoConteudo}: ${erroMsg} ${origemInfo}`, erro.stack);

    // Se for erro de Safety, tentar salvar diagnóstico (sem bloquear)
    if (erroMsg.includes('SAFETY') || erroMsg.includes('blocked') || (erro.status === 400 && erroMsg.includes('user location'))) {
      registrador.warn(`⚠️ Detalhe do erro: Conteúdo bloqueado por SAFETY.`); // Log específico de safety
      const diretorioBloqueados = path.join(process.cwd(), 'blocked');
      const salvarBloqueado = salvarConteudoBloqueado(tipoConteudo, diretorioBloqueados);
      // Executar em background, não esperar
      salvarBloqueado({ origemInfo: dadosOrigem, ...infoExtra }, erro)
        .then(res => {
          if (res.sucesso) registrador.info(`Diagnóstico de ${tipoConteudo} bloqueado salvo: ${res.dados.caminhoJson}`);
          else registrador.error(`Erro ao salvar diagnóstico de ${tipoConteudo} bloqueado (Resultado.falha): ${res.erro.message}`);
        })
        .catch(errSalvar => registrador.error(`Erro ao salvar diagnóstico de ${tipoConteudo} bloqueado (Exceção): ${errSalvar.message}`));
    }

    // Retornar sempre Resultado.falha com o erro original
    return Resultado.falha(erro);
  };

  /**
   * Verifica o cache para uma requisição e registra HIT ou MISS.
   * @param {string} tipo - Tipo de processamento.
   * @param {Object} payload - Dados para gerar a chave de cache.
   * @param {Object} config - Configurações da IA.
   * @param {NodeCache} cache - Instância do NodeCache.
   * @param {Object} registrador - Instância do registrador.
   * @param {string} [tipoLogExtra=''] - Informação extra para o log (ex: tipo de documento).
   * @returns {Promise<Resultado<{hit: boolean, valor: any|null, chaveCache: string}, Error>>} Resultado da verificação do cache.
   */
  const verificarCache = async (tipo, payload, config, cache, registrador, tipoLogExtra = '') => {
    let chaveCache;
    const logTipo = tipoLogExtra ? `${tipo} (${tipoLogExtra})` : tipo;
    try {
      chaveCache = await criarChaveCache(tipo, payload, config);

      // Adiciona verificação explícita da chave antes de usar no cache.get
      if (typeof chaveCache !== 'string' || chaveCache.length === 0) {
        throw new Error(`Chave de cache inválida gerada: ${chaveCache}`);
      }

      const cacheHit = cache.get(chaveCache);
      if (cacheHit) {
        registrador.info(`[Cache HIT] ${logTipo}: ${chaveCache}`);
        return Resultado.sucesso({ hit: true, valor: cacheHit, chaveCache });
      }
      registrador.debug(`[Cache MISS] ${logTipo}: ${chaveCache}`);
      return Resultado.sucesso({ hit: false, valor: null, chaveCache });
    } catch (err) {
      const erroCache = new Error(`Erro ao gerar/verificar chave de cache para ${logTipo}: ${err.message}`);
      registrador.warn(`[Cache] ${erroCache.message}. Cache desativado para esta requisição.`);
      return Resultado.falha(erroCache); // Retorna falha com o erro
    }
  };

  // --- Funções de Processamento (Interface Exposta) ---

  const processarTexto = async (texto, config) => {
    const tipo = 'texto';
    let chaveCache = null;

    // 1. Verificar Cache
    const resultadoCache = await verificarCache(tipo, { texto }, config, cacheRespostas, registrador);
    if (!resultadoCache.sucesso) {
      // Logar erro do cache, mas continuar sem cache
      registrador.error(`[${tipo}] Falha ao verificar cache: ${resultadoCache.erro.message}`);
    } else {
      chaveCache = resultadoCache.dados.chaveCache; // Guarda a chave
      if (resultadoCache.dados.hit) {
        // Retornar sucesso com valor do cache
        return Resultado.sucesso(resultadoCache.dados.valor);
      }
      // Cache MISS, continuar...
    }

    // 2. Executar Geração (com resiliência)
    const modelo = obterOuCriarModelo(config);
    const resultadoExec = await executarComResiliencia('processarTexto', () => modelo.generateContent(texto));
    if (!resultadoExec.sucesso) {
      // executarComResiliencia já logou o erro e retorna Resultado.falha
      // Apenas propagar a falha
      return resultadoExec;
    }

    // 3. Processar Resposta (tratar safety, etc.)
    const resultadoProc = processarRespostaIA(resultadoExec.dados, tipo, config.dadosOrigem);
    if (!resultadoProc.sucesso) {
      // processarRespostaIA já logou o erro e retorna Resultado.falha
      // Apenas propagar a falha
      return resultadoProc;
    }

    // 4. Sucesso: Salvar no cache (se possível) e retornar Resultado.sucesso
    const respostaFinal = resultadoProc.dados;
    if (chaveCache) {
      registrador.debug(`[${tipo}] Tentando salvar no cache. Chave: "${chaveCache}"`);
      cacheRespostas.set(chaveCache, respostaFinal);
    }
    return Resultado.sucesso(respostaFinal);
  };

  const processarImagem = async (imagemData, prompt, config) => {
    const tipo = 'imagem';
    let chaveCache = null;

    // 1. Verificar Cache
    const resultadoCache = await verificarCache(tipo, { dadosAnexo: imagemData, prompt }, config, cacheRespostas, registrador);
    if (!resultadoCache.sucesso) {
      registrador.error(`[${tipo}] Falha ao verificar cache: ${resultadoCache.erro.message}`);
    } else {
      chaveCache = resultadoCache.dados.chaveCache;
      if (resultadoCache.dados.hit) {
        // Retornar sucesso com valor do cache
        return Resultado.sucesso(resultadoCache.dados.valor);
      }
      // Cache MISS, continuar...
    }

    // 2. Preparar Conteúdo para API
    const modelo = obterOuCriarModelo(config);
    const parteImagem = { inlineData: { data: imagemData.data, mimeType: imagemData.mimetype } };
    const textoParaEnviar = config.systemInstructions || (prompt || "Descreva esta imagem.");
    const partesConteudo = [parteImagem, { text: textoParaEnviar }];

    // 3. Executar Geração (com resiliência)
    const resultadoExec = await executarComResiliencia('processarImagem', () => modelo.generateContent(partesConteudo));
    if (!resultadoExec.sucesso) {
      // Propagar falha (erro já logado por executarComResiliencia)
      return resultadoExec;
    }

    // 4. Processar Resposta (tratar safety, etc.)
    // Passar resultadoExec.dados (o resultado da API) para processarRespostaIA
    const resultadoProc = processarRespostaIA(resultadoExec.dados, tipo, config.dadosOrigem);
    if (!resultadoProc.sucesso) {
      // Propagar falha (erro já logado por processarRespostaIA)
      return resultadoProc;
    }

    // 5. Sucesso: Salvar no cache (se possível) e retornar Resultado.sucesso
    const respostaFinal = resultadoProc.dados;
    if (chaveCache) {
      registrador.debug(`[${tipo}] Tentando salvar no cache. Chave: "${chaveCache}"`);
      cacheRespostas.set(chaveCache, respostaFinal);
    }
    // Adicionar prefixo (se necessário, mas a lógica de prefixo pode ser movida para o chamador)
    // const prefixo = "[Descrição de Imagem]\n\n"; // Exemplo
    // return Resultado.sucesso(`${prefixo}${respostaFinal}`);
    return Resultado.sucesso(respostaFinal);
  };

  const processarAudio = async (audioData, audioId, config) => {
    const tipo = 'audio';
    let chaveCache = null;

    // 1. Verificar Cache (usando audioId como parte do prompt para cache)
    const resultadoCache = await verificarCache(tipo, { dadosAnexo: audioData, prompt: audioId }, config, cacheRespostas, registrador);
    if (!resultadoCache.sucesso) {
      registrador.error(`[${tipo}] Falha ao verificar cache: ${resultadoCache.erro.message}`);
    } else {
      chaveCache = resultadoCache.dados.chaveCache;
      if (resultadoCache.dados.hit) {
        return Resultado.sucesso(resultadoCache.dados.valor); // Retorna sucesso com valor do cache
      }
      // Cache MISS, continuar...
    }

    // 2. Preparar Conteúdo e Config para API
    const configAI = {
      ...config,
      temperature: 0.3, // Menor temp para transcrição
      systemInstruction: config.systemInstruction || obterInstrucaoAudio()
    };
    const modelo = obterOuCriarModelo(configAI);
    const parteAudio = { inlineData: { mimeType: audioData.mimetype, data: audioData.data } };
    const promptTexto = `Transcreva o áudio com ID ${audioId} e resuma seu conteúdo em português.`;
    const partesConteudo = [parteAudio, { text: promptTexto }];

    // 3. Executar Geração (com resiliência)
    const resultadoExec = await executarComResiliencia('processarAudio', () => modelo.generateContent(partesConteudo));
    if (!resultadoExec.sucesso) {
      return resultadoExec; // Propagar falha
    }

    // 4. Processar Resposta (tratar safety, etc.)
    const resultadoProc = processarRespostaIA(resultadoExec.dados, tipo, config.dadosOrigem);
    if (!resultadoProc.sucesso) {
      return resultadoProc; // Propagar falha
    }

    // 5. Sucesso: Salvar no cache (se possível) e retornar Resultado.sucesso
    const respostaFinal = resultadoProc.dados;
    if (chaveCache) {
      registrador.debug(`[${tipo}] Tentando salvar no cache. Chave: "${chaveCache}"`);
      cacheRespostas.set(chaveCache, respostaFinal);
    }
    // Adicionar prefixo (se necessário, mas pode ser movido para o chamador)
    // const prefixo = "[Transcrição de Áudio]\n\n"; // Exemplo
    // return Resultado.sucesso(`${prefixo}${respostaFinal}`);
    return Resultado.sucesso(respostaFinal);
  };

  const processarDocumentoInline = async (documentoData, prompt, config) => {
    const tipo = 'documentoInline';
    const mimeType = documentoData.mimetype || 'application/octet-stream';
    const tipoDocLog = mimeType.split('/')[1]?.split('+')[0] || mimeType.split('/')[1] || 'documento';
    let chaveCache = null;

    // 1. Verificar Cache
    const resultadoCache = await verificarCache(tipo, { dadosAnexo: documentoData, prompt }, config, cacheRespostas, registrador, tipoDocLog);
    if (!resultadoCache.sucesso) {
      registrador.error(`[${tipo} (${tipoDocLog})] Falha ao verificar cache: ${resultadoCache.erro.message}`);
    } else {
      chaveCache = resultadoCache.dados.chaveCache;
      if (resultadoCache.dados.hit) {
        return Resultado.sucesso(resultadoCache.dados.valor); // Retorna sucesso com valor do cache
      }
      // Cache MISS, continuar...
    }

    // 2. Preparar Conteúdo e Config para API
    const configAI = {
      ...config,
      systemInstruction: config.systemInstruction || obterInstrucaoDocumento()
    };
    const modelo = obterOuCriarModelo(configAI);
    const parteDoc = { inlineData: { mimeType: mimeType, data: documentoData.data } };
    const promptTexto = prompt || `Analise este documento (${tipoDocLog}) e forneça um resumo.`;
    const partesConteudo = [parteDoc, { text: promptTexto }];

    // 3. Executar Geração (com resiliência e timeout maior)
    const resultadoExec = await executarComResiliencia('processarDocumentoInline', () => modelo.generateContent(partesConteudo), TIMEOUT_API_UPLOAD_MS);
    if (!resultadoExec.sucesso) {
      return resultadoExec; // Propagar falha
    }

    // 4. Processar Resposta (tratar safety, etc.)
    const resultadoProc = processarRespostaIA(resultadoExec.dados, tipoDocLog, config.dadosOrigem);
    if (!resultadoProc.sucesso) {
      return resultadoProc; // Propagar falha
    }

    // 5. Sucesso: Salvar no cache (se possível) e retornar Resultado.sucesso
    const respostaFinal = resultadoProc.dados;
    if (chaveCache) {
      registrador.debug(`[${tipo} (${tipoDocLog})] Tentando salvar no cache. Chave: "${chaveCache}"`);
      cacheRespostas.set(chaveCache, respostaFinal);
    }
    // Adicionar prefixo (se necessário)
    // const prefixo = "[Resumo Documento]\n\n"; // Exemplo
    // return Resultado.sucesso(`${prefixo}${respostaFinal}`);
    return Resultado.sucesso(respostaFinal);
  };

  // NOTA: processarDocumentoArquivo e processarVideo ainda usam GoogleAIFileManager
  // A integração com rate limiter e cache é mais complexa aqui devido ao ciclo upload->wait->process->delete

  const processarDocumentoArquivo = async (caminhoDocumento, prompt, config) => {
    const tipo = 'documentoArquivo';
    const mimeType = config.mimeType || 'application/octet-stream';
    const tipoDocLog = mimeType.split('/')[1] || 'documento';
    let nomeArquivoGoogle = null;
    let chaveCache = null;

    // --- Funções Auxiliares Específicas ---
    const tentarDeleteGoogle = async (nomeArquivo) => {
      if (!nomeArquivo) return;
      registrador.info(`[${tipo}] Tentando deletar arquivo [${nomeArquivo}] do Google AI (cleanup).`);
      // Usar executarComResiliencia para o delete também
      const resultadoDelete = await executarComResiliencia(
        'deleteFileDocCleanup', // Nome diferente para logs
        () => gerenciadorArquivosGoogle.deleteFile(nomeArquivo)
      );
      if (!resultadoDelete.sucesso) {
        registrador.error(`[${tipo}] Erro no cleanup ao deletar arquivo [${nomeArquivo}]: ${resultadoDelete.erro.message}`);
      } else {
        registrador.info(`[${tipo}] Arquivo [${nomeArquivo}] deletado com sucesso (cleanup).`);
      }
    };

    // --- Fluxo Principal com Ferrovia (usando IIFE async para gerenciar cleanup) ---
    const resultadoProcessamento = await (async () => {
      // 1. Verificar Cache
      const resultadoCache = await verificarCache(tipo, { caminhoArquivo: caminhoDocumento, prompt }, config, cacheRespostas, registrador, tipoDocLog);
      if (!resultadoCache.sucesso) {
        registrador.error(`[${tipo} (${tipoDocLog})] Falha ao verificar cache: ${resultadoCache.erro.message}`);
        // Continuar sem cache
      } else {
        chaveCache = resultadoCache.dados.chaveCache;
        if (resultadoCache.dados.hit) {
          return Resultado.sucesso(resultadoCache.dados.valor); // Cache HIT
        }
      }

      // 2. Upload
      registrador.info(`[${tipo}] Iniciando processamento: ${caminhoDocumento}`);
      let mimeTypeParaUpload = mimeType === 'application/octet-stream' ? 'text/plain' : mimeType;
      const resultadoUpload = await executarComResiliencia(
        'uploadFileDoc',
        () => gerenciadorArquivosGoogle.uploadFile(caminhoDocumento, {
          mimeType: mimeTypeParaUpload,
          displayName: path.basename(caminhoDocumento) || `${tipoDocLog.toUpperCase()} Enviado`
        }),
        TIMEOUT_API_UPLOAD_MS
      );
      if (!resultadoUpload.sucesso) return resultadoUpload; // Propagar falha
      nomeArquivoGoogle = resultadoUpload.dados.file.name; // Guardar nome para cleanup
      registrador.info(`[${tipo}] Upload concluído: ${nomeArquivoGoogle} (Mimetype Upload: ${mimeTypeParaUpload})`);

      // 3. Espera pelo Processamento
      let arquivo;
      let tentativasEspera = 0;
      const maxTentativasEspera = 15;
      const tempoEsperaPolling = 10000;
      let resultadoGetArquivo;
      do {
        registrador.info(`[${tipo}] [${nomeArquivoGoogle}] Aguardando processamento... (tentativa ${tentativasEspera + 1}/${maxTentativasEspera})`);
        await new Promise(resolve => setTimeout(resolve, tempoEsperaPolling));
        resultadoGetArquivo = await executarComResiliencia(
           'getFileDoc',
           () => gerenciadorArquivosGoogle.getFile(nomeArquivoGoogle)
        );
        // Se falhar ao obter o estado, retornar a falha
        if (!resultadoGetArquivo.sucesso) return resultadoGetArquivo;
        arquivo = resultadoGetArquivo.dados;
        tentativasEspera++;
      } while (arquivo.state === "PROCESSING" && tentativasEspera < maxTentativasEspera);

      // Verificar estado após o loop
      if (arquivo.state === "FAILED") {
        return Resultado.falha(new Error(`Falha no processamento do arquivo ${tipoDocLog} [${nomeArquivoGoogle}] pelo Google AI`));
      }
      if (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE") {
         if (tentativasEspera >= maxTentativasEspera) {
             return Resultado.falha(new Error(`Timeout esperando processamento do arquivo ${tipoDocLog} [${nomeArquivoGoogle}]`));
         }
        return Resultado.falha(new Error(`Estado inesperado (${arquivo.state}) no processamento do arquivo ${tipoDocLog} [${nomeArquivoGoogle}]`));
      }
      registrador.info(`[${tipo}] [${nomeArquivoGoogle}] Pronto para análise. Estado: ${arquivo.state}`);

      // 4. Geração de Conteúdo
      const configAI = { ...config, systemInstruction: config.systemInstruction || obterInstrucaoDocumento() };
      const modelo = obterOuCriarModelo(configAI);
      const promptTexto = prompt || `Analise este documento (${tipoDocLog}) e forneça um resumo.`;
      const partesConteudo = [{ fileData: { mimeType: arquivo.mimeType, fileUri: arquivo.uri } }, { text: promptTexto }];
      const resultadoGenerate = await executarComResiliencia(
        'generateContentDocArquivo',
        () => modelo.generateContent(partesConteudo),
        TIMEOUT_API_UPLOAD_MS
      );
      if (!resultadoGenerate.sucesso) return resultadoGenerate; // Propagar falha

      // 5. Processar Resposta IA
      const resultadoProc = processarRespostaIA(resultadoGenerate.dados, tipoDocLog, config.dadosOrigem);
      if (!resultadoProc.sucesso) return resultadoProc; // Propagar falha

      // 6. Sucesso: Salvar no cache e retornar
      const respostaFinal = resultadoProc.dados;
      if (chaveCache) {
        registrador.debug(`[${tipo} (${tipoDocLog})] Tentando salvar no cache. Chave: "${chaveCache}"`);
        cacheRespostas.set(chaveCache, respostaFinal);
      }
      // Adicionar prefixo (se necessário)
      // const prefixo = "[Resumo Documento]\n\n";
      // return Resultado.sucesso(`${prefixo}${respostaFinal}`);
      return Resultado.sucesso(respostaFinal);

    })(); // Fim da IIFE async

    // --- Cleanup (Executa após o resultado do pipeline, seja sucesso ou falha) ---
    // Usar o nome do arquivo guardado anteriormente
    await tentarDeleteGoogle(nomeArquivoGoogle);

    // Retornar o resultado final do pipeline
    return resultadoProcessamento;
  };

  const processarVideo = async (caminhoVideo, prompt, config) => {
    const tipo = 'video';
    const mimeType = config.mimeType || 'video/mp4';
    let nomeArquivoGoogle = null;
    let chaveCache = null;

    // --- Funções Auxiliares Específicas ---
    const tentarDeleteGoogle = async (nomeArquivo) => {
      if (!nomeArquivo) return;
      registrador.info(`[${tipo}] Tentando deletar arquivo [${nomeArquivo}] do Google AI (cleanup).`);
      const resultadoDelete = await executarComResiliencia(
        'deleteFileVideoCleanup',
        () => gerenciadorArquivosGoogle.deleteFile(nomeArquivo)
      );
      if (!resultadoDelete.sucesso) {
        registrador.error(`[${tipo}] Erro no cleanup ao deletar arquivo [${nomeArquivo}]: ${resultadoDelete.erro.message}`);
      } else {
        registrador.info(`[${tipo}] Arquivo [${nomeArquivo}] deletado com sucesso (cleanup).`);
      }
    };

    // --- Fluxo Principal com Ferrovia (usando IIFE async) ---
    const resultadoProcessamento = await (async () => {
      // 1. Verificar Cache
      const resultadoCache = await verificarCache(tipo, { caminhoArquivo: caminhoVideo, prompt }, config, cacheRespostas, registrador);
      if (!resultadoCache.sucesso) {
        registrador.error(`[${tipo}] Falha ao verificar cache: ${resultadoCache.erro.message}`);
      } else {
        chaveCache = resultadoCache.dados.chaveCache;
        if (resultadoCache.dados.hit) {
          return Resultado.sucesso(resultadoCache.dados.valor); // Cache HIT
        }
      }

      // 2. Upload
      registrador.info(`[${tipo}] Iniciando processamento: ${caminhoVideo}`);
      const resultadoUpload = await executarComResiliencia(
        'uploadFileVideo',
        () => gerenciadorArquivosGoogle.uploadFile(caminhoVideo, {
          mimeType: mimeType,
          displayName: path.basename(caminhoVideo) || "Vídeo Enviado"
        }),
        TIMEOUT_API_UPLOAD_MS
      );
      if (!resultadoUpload.sucesso) return resultadoUpload;
      nomeArquivoGoogle = resultadoUpload.dados.file.name;
      registrador.info(`[${tipo}] Upload concluído: ${nomeArquivoGoogle}`);

      // 3. Espera pelo Processamento
      let arquivo;
      let tentativasEspera = 0;
      const maxTentativasEspera = 18;
      const tempoEsperaPolling = 10000;
      let resultadoGetArquivo;
      do {
        registrador.info(`[${tipo}] [${nomeArquivoGoogle}] Aguardando processamento... (tentativa ${tentativasEspera + 1}/${maxTentativasEspera})`);
        await new Promise(resolve => setTimeout(resolve, tempoEsperaPolling));
        resultadoGetArquivo = await executarComResiliencia(
           'getFileVideo',
           () => gerenciadorArquivosGoogle.getFile(nomeArquivoGoogle)
        );
        if (!resultadoGetArquivo.sucesso) return resultadoGetArquivo;
        arquivo = resultadoGetArquivo.dados;
        tentativasEspera++;
      } while (arquivo.state === "PROCESSING" && tentativasEspera < maxTentativasEspera);

      // Verificar estado após o loop
      if (arquivo.state === "FAILED") {
        return Resultado.falha(new Error(`Falha no processamento do vídeo [${nomeArquivoGoogle}] pelo Google AI`));
      }
      if (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE") {
        if (tentativasEspera >= maxTentativasEspera) {
             return Resultado.falha(new Error(`Timeout esperando processamento do vídeo [${nomeArquivoGoogle}]`));
         }
        return Resultado.falha(new Error(`Estado inesperado (${arquivo.state}) no processamento do vídeo [${nomeArquivoGoogle}]`));
      }
      registrador.info(`[${tipo}] [${nomeArquivoGoogle}] Pronto para análise. Estado: ${arquivo.state}`);

      // 4. Geração de Conteúdo
      const modoLegenda = config.modoDescricao === 'legenda' || config.usarLegenda === true;
      const promptTexto = modoLegenda ? (prompt || obterPromptVideoLegenda()) : (prompt || "Analise este vídeo e forneça um resumo.");
      const configAI = { ...config, systemInstruction: config.systemInstruction || obterInstrucaoPadrao() };
      const modelo = obterOuCriarModelo(configAI);
      const partesConteudo = [{ fileData: { mimeType: arquivo.mimeType, fileUri: arquivo.uri } }, { text: promptTexto }];
      const resultadoGenerate = await executarComResiliencia(
        'generateContentVideo',
        () => modelo.generateContent(partesConteudo),
        TIMEOUT_API_UPLOAD_MS
      );
      if (!resultadoGenerate.sucesso) return resultadoGenerate;

      // 5. Processar Resposta IA
      const resultadoProc = processarRespostaIA(resultadoGenerate.dados, tipo, config.dadosOrigem);
      if (!resultadoProc.sucesso) return resultadoProc;

      // 6. Sucesso: Salvar no cache, adicionar prefixo e retornar
      const respostaFinal = resultadoProc.dados;
      if (chaveCache) {
        registrador.debug(`[${tipo}] Tentando salvar no cache. Chave: "${chaveCache}"`);
        cacheRespostas.set(chaveCache, respostaFinal);
      }
      const prefixo = modoLegenda ? "[Transcrição de Vídeo]\n\n" : "[Descrição de Vídeo]\n\n";
      return Resultado.sucesso(`${prefixo}${respostaFinal}`);

    })(); // Fim da IIFE async

    // --- Cleanup ---
    await tentarDeleteGoogle(nomeArquivoGoogle);

    // Retornar o resultado final (que pode ser sucesso ou falha)
    // Se ocorreu um erro dentro da IIFE, tratarErroAPI não é mais chamado aqui,
    // pois o Resultado.falha já foi retornado e será tratado pelo chamador.
    return resultadoProcessamento;
  };

  // --- Funções Auxiliares para Gerenciamento de Arquivos Google ---

  const uploadArquivoGoogle = async (caminhoArquivo, opcoesUpload, timeoutMs = TIMEOUT_API_UPLOAD_MS) => {
    registrador.debug(`[AdpAI] Iniciando upload Google: ${caminhoArquivo}`);
    // executarComResiliencia já retorna Promise<Resultado>
    const resultado = await executarComResiliencia(
      'uploadArquivoGoogle',
      () => gerenciadorArquivosGoogle.uploadFile(caminhoArquivo, opcoesUpload),
      timeoutMs
    );
    // Apenas retornamos o resultado encapsulado
    return resultado;
  };

  const deleteArquivoGoogle = async (nomeArquivoGoogle, timeoutMs = TIMEOUT_API_GERAL_MS) => {
    if (!nomeArquivoGoogle) {
      // Retornar um sucesso silencioso se não houver nome, pois não há o que deletar
      return Resultado.sucesso(true);
    }
    registrador.debug(`[AdpAI] Iniciando delete Google: ${nomeArquivoGoogle}`);
    // executarComResiliencia já retorna Promise<Resultado>
    const resultado = await executarComResiliencia(
      'deleteArquivoGoogle',
      () => gerenciadorArquivosGoogle.deleteFile(nomeArquivoGoogle),
      timeoutMs
    );

    if (resultado.sucesso) {
      registrador.info(`[AdpAI] Arquivo Google deletado: ${nomeArquivoGoogle}`);
      // Retornar sucesso explícito
      return Resultado.sucesso(true);
    } else {
      // Logar o erro, mas retornar sucesso mesmo assim para não interromper fluxos de cleanup
      registrador.error(`[AdpAI] Falha ao deletar arquivo Google ${nomeArquivoGoogle}: ${resultado.erro.message}`);
      // Consideramos a falha na exclusão como não crítica para o fluxo principal
      return Resultado.sucesso(false); // Indica que a exclusão falhou, mas não é um erro bloqueante
    }
  };

  const getArquivoGoogle = async (nomeArquivoGoogle, timeoutMs = TIMEOUT_API_GERAL_MS) => {
     registrador.debug(`[AdpAI] Obtendo estado arquivo Google: ${nomeArquivoGoogle}`);
     // executarComResiliencia já retorna Promise<Resultado>
     const resultado = await executarComResiliencia(
        'getArquivoGoogle',
        () => gerenciadorArquivosGoogle.getFile(nomeArquivoGoogle),
        timeoutMs
     );
     // Apenas retornamos o resultado encapsulado
     return resultado;
  };

  /**
   * Gera conteúdo a partir de um arquivo já existente no Google AI (via URI).
   * Usado pelas filas após o upload e processamento inicial.
   */
  const gerarConteudoDeArquivoUri = async (fileUri, mimeType, prompt, config) => {
    const tipo = config.tipoMidia || 'arquivoUri';
    registrador.debug(`[${tipo}] Iniciando geração de conteúdo: ${fileUri}`);

    // 1. Preparar Conteúdo e Config para API
    // Usar a config recebida, que já contém a systemInstruction correta (persona)
    const modelo = obterOuCriarModelo(config); // Configura o modelo SÓ com a persona (ou padrão geral)
    // Enviar a instrução PADRÃO da mídia (tarefa) como o prompt de texto junto com o arquivo.
    const textoParaEnviar = config.instrucaoPadraoMidia || prompt; // Usa prompt original se instrução padrão não veio
    const partesConteudo = [{ fileData: { mimeType: mimeType, fileUri: fileUri } }, { text: textoParaEnviar }];

    // 2. Executar Geração (com resiliência e timeout maior)
    const resultadoExec = await executarComResiliencia(
      `generateContent${_.capitalize(tipo)}`, // Nome dinâmico para log
      () => modelo.generateContent(partesConteudo),
      TIMEOUT_API_UPLOAD_MS // Usar timeout maior para análise de arquivos
    );
    if (!resultadoExec.sucesso) {
      // Propagar falha (erro já logado)
      // O chamador (FilasProcessadores) decidirá como notificar o usuário
      return resultadoExec;
    }

    // 3. Processar Resposta (tratar safety, etc.)
    const resultadoProc = processarRespostaIA(resultadoExec.dados, tipo, config.dadosOrigem);
    if (!resultadoProc.sucesso) {
      // Propagar falha (erro já logado)
      return resultadoProc;
    }

    // 4. Sucesso: Adicionar prefixo (se necessário) e retornar Resultado.sucesso
    const respostaFinal = resultadoProc.dados;
    let respostaComPrefixo = respostaFinal; // Inicializa sem prefixo

    if (tipo === 'video') {
      const prefixo = config.modoDescricao === 'legenda' ? "[Transcrição de Vídeo]\n\n" : "[Descrição de Vídeo]\n\n";
      respostaComPrefixo = `${prefixo}${respostaFinal}`;
    }
    // Adicionar prefixos para outros tipos se necessário aqui...

    return Resultado.sucesso(respostaComPrefixo);
  };


  // --- Retorno da Fábrica ---
  // Expõe as funções que implementam a interface IAPort (implicitamente)
  return {
    processarTexto,
    processarImagem,
    processarAudio,
    processarDocumentoInline,
    processarDocumentoArquivo,
    processarVideo,

    // Funções de gerenciamento de arquivos expostas para as filas
    uploadArquivoGoogle,
    deleteArquivoGoogle,
    getArquivoGoogle,
    gerarConteudoDeArquivoUri,
  };
};

module.exports = criarAdaptadorAI; // Exporta a fábrica
