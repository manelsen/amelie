/*/**
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
    systemInstruction: config.systemInstruction // Inclui instrução no hash
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
      systemInstruction: config.systemInstruction || obterInstrucaoPadrao()
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
        registrador.warn(`[${nomeOperacao}] Circuit Breaker ABERTO. Requisição bloqueada.`);
        throw new Error("Serviço de IA temporariamente indisponível (Circuit Breaker).");
      }

      try {
        const promessaResultado = rateLimiter.schedule(() => funcaoApi());
        const promessaTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout da API Gemini (${timeoutMs}ms) em ${nomeOperacao}`)), timeoutMs)
        );

        const resultado = await Promise.race([promessaResultado, promessaTimeout]);

        // Sucesso: atualiza CB e retorna
        estadoCB = registrarSucessoCB(estadoCB);
        return resultado;

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
        if (tentativas < MAX_TENTATIVAS_API && (erro.message.includes('503') || erro.message.includes('UNAVAILABLE') || erro.message.includes('Timeout'))) {
          const tempoEsperaAtual = TEMPO_ESPERA_BASE_MS * Math.pow(2, tentativas - 1);
          registrador.info(`[${nomeOperacao}] Aguardando ${tempoEsperaAtual}ms antes da próxima tentativa...`);
          await new Promise(resolve => setTimeout(resolve, tempoEsperaAtual));
          continue; // Próxima iteração do while
        }

        // Se não for erro de retry ou excedeu tentativas, lança o erro
        throw erro;
      }
    }
    // Se saiu do loop, é porque excedeu tentativas
    throw new Error(`[${nomeOperacao}] Falha após ${MAX_TENTATIVAS_API} tentativas.`);
  };

  /**
   * Processa a resposta da IA, tratando erros de safety e respostas vazias.
   */
  const processarRespostaIA = (resultado, tipoConteudo, dadosOrigem) => {
    const origemInfo = dadosOrigem ? `[Origem: ${dadosOrigem.tipo} "${dadosOrigem.nome}" (${dadosOrigem.id})]` : '[Origem desconhecida]';

    // Verificar safety blocks na resposta
    if (resultado.response?.promptFeedback?.blockReason) {
      const blockReason = resultado.response.promptFeedback.blockReason;
      registrador.warn(`⚠️ Conteúdo de ${tipoConteudo} bloqueado por SAFETY (promptFeedback): ${blockReason} ${origemInfo}`);
      throw new Error(`Conteúdo bloqueado por SAFETY: ${blockReason}`); // Lança erro específico
    }
    if (resultado.response?.candidates?.[0]?.finishReason === 'SAFETY') {
      const safetyRatings = resultado.response?.candidates?.[0]?.safetyRatings;
      registrador.warn(`⚠️ Conteúdo de ${tipoConteudo} bloqueado por SAFETY (finishReason). Ratings: ${JSON.stringify(safetyRatings)} ${origemInfo}`);
      throw new Error("Conteúdo bloqueado por SAFETY"); // Lança erro específico
    }

    const textoResposta = resultado.response?.text();

    if (!textoResposta || typeof textoResposta !== 'string' || textoResposta.trim() === '') {
      registrador.warn(`[AdpAI] Resposta vazia ou inválida recebida para ${tipoConteudo}. ${origemInfo}`);
      throw new Error(`Resposta vazia ou inválida da IA para ${tipoConteudo}.`);
    }

    return limparResposta(textoResposta);
  };

  /**
   * Trata erros específicos da API, incluindo safety e erros gerais.
   */
  const tratarErroAPI = (erro, tipoConteudo, dadosOrigem, infoExtra = {}) => {
    const origemInfo = dadosOrigem ? `[Origem: ${dadosOrigem.tipo} "${dadosOrigem.nome}" (${dadosOrigem.id})]` : '[Origem desconhecida]';
    const erroMsg = erro.message || 'Erro desconhecido';

    // Erros de Safety
    if (erroMsg.includes('SAFETY') || erroMsg.includes('blocked') || (erro.status === 400 && erroMsg.includes('user location'))) {
      registrador.warn(`⚠️ Conteúdo de ${tipoConteudo} bloqueado por SAFETY (Erro Capturado): ${erroMsg} ${origemInfo}`);

      // Tentar salvar conteúdo bloqueado (não bloquear o fluxo principal)
      const diretorioBloqueados = path.join(process.cwd(), 'blocked');
      const salvarBloqueado = salvarConteudoBloqueado(tipoConteudo, diretorioBloqueados);
      salvarBloqueado({ origemInfo: dadosOrigem, ...infoExtra }, erro)
        .then(res => res.sucesso && registrador.info(`Diagnóstico de ${tipoConteudo} bloqueado salvo: ${res.dados.caminhoJson}`))
        .catch(errSalvar => registrador.error(`Erro ao salvar diagnóstico de ${tipoConteudo} bloqueado: ${errSalvar.message}`));

      return "Este conteúdo não pôde ser processado por questões de segurança."; // Mensagem para usuário
    }

    // Outros erros
    registrador.error(`[AdpAI] Erro ao processar ${tipoConteudo}: ${erroMsg} ${origemInfo}`, erro.stack);
    return `Desculpe, o serviço de IA está temporariamente indisponível ao processar ${tipoConteudo}. Por favor, tente novamente em alguns instantes.`; // Mensagem genérica
  };


  // --- Funções de Processamento (Interface Exposta) ---

  const processarTexto = async (texto, config) => {
    const tipo = 'texto';
    const chaveCache = await criarChaveCache(tipo, { texto }, config);
    const cacheHit = cacheRespostas.get(chaveCache);
    if (cacheHit) {
      registrador.info(`[Cache HIT] ${tipo}: ${chaveCache}`);
      return cacheHit;
    }
    registrador.debug(`[Cache MISS] ${tipo}: ${chaveCache}`);

    try {
      const modelo = obterOuCriarModelo(config);
      const resultado = await executarComResiliencia('processarTexto', () => modelo.generateContent(texto));
      const resposta = processarRespostaIA(resultado, tipo, config.dadosOrigem);

      cacheRespostas.set(chaveCache, resposta);
      return resposta;
    } catch (erro) {
      return tratarErroAPI(erro, tipo, config.dadosOrigem, { texto, config });
    }
  };

  const processarImagem = async (imagemData, prompt, config) => {
    const tipo = 'imagem';
    const chaveCache = await criarChaveCache(tipo, { dadosAnexo: imagemData, prompt }, config);
    const cacheHit = cacheRespostas.get(chaveCache);
    if (cacheHit) {
      registrador.info(`[Cache HIT] ${tipo}: ${chaveCache}`);
      return cacheHit;
    }
     registrador.debug(`[Cache MISS] ${tipo}: ${chaveCache}`);

    try {
      // Ajustar instrução com base no modo (curto/longo)
      const modoDescricao = config.modoDescricao || 'longo'; // Padrão longo se não especificado
      const systemInstruction = modoDescricao === 'curto' ? obterInstrucaoImagemCurta() : obterInstrucaoImagem();
      const configAI = { ...config, systemInstruction };

      const modelo = obterOuCriarModelo(configAI);
      const parteImagem = { inlineData: { data: imagemData.data, mimeType: imagemData.mimetype } };
      const partesConteudo = [parteImagem, { text: prompt || "Descreva esta imagem." }]; // Prompt padrão

      const resultado = await executarComResiliencia('processarImagem', () => modelo.generateContent(partesConteudo));
      const resposta = processarRespostaIA(resultado, tipo, config.dadosOrigem);

      cacheRespostas.set(chaveCache, resposta);
      // Adicionar prefixo
      return resposta;
    } catch (erro) {
      return tratarErroAPI(erro, tipo, config.dadosOrigem, { prompt, mimeType: imagemData.mimetype, config });
    }
  };

  const processarAudio = async (audioData, audioId, config) => {
    const tipo = 'audio';
    const chaveCache = await criarChaveCache(tipo, { dadosAnexo: audioData, prompt: audioId }, config); // Usar audioId no prompt para cache
    const cacheHit = cacheRespostas.get(chaveCache);
    if (cacheHit) {
      registrador.info(`[Cache HIT] ${tipo}: ${chaveCache}`);
      return cacheHit;
    }
    registrador.debug(`[Cache MISS] ${tipo}: ${chaveCache}`);

    try {
      const configAI = {
        ...config,
        temperature: 0.3, // Menor temp para transcrição
        systemInstruction: config.systemInstruction || obterInstrucaoAudio()
      };
      const modelo = obterOuCriarModelo(configAI);
      const parteAudio = { inlineData: { mimeType: audioData.mimetype, data: audioData.data } };
      const promptTexto = `Transcreva o áudio com ID ${audioId} e resuma seu conteúdo em português.`;
      const partesConteudo = [parteAudio, { text: promptTexto }];

      const resultado = await executarComResiliencia('processarAudio', () => modelo.generateContent(partesConteudo));
      const resposta = processarRespostaIA(resultado, tipo, config.dadosOrigem);

      cacheRespostas.set(chaveCache, resposta);
      // Adicionar prefixo
      return resposta;
    } catch (erro) {
      return tratarErroAPI(erro, tipo, config.dadosOrigem, { audioId, mimeType: audioData.mimetype, config });
    }
  };

  const processarDocumentoInline = async (documentoData, prompt, config) => {
    const tipo = 'documentoInline';
    const mimeType = documentoData.mimetype || 'application/octet-stream';
    const tipoDocLog = mimeType.split('/')[1]?.split('+')[0] || mimeType.split('/')[1] || 'documento';
    const chaveCache = await criarChaveCache(tipo, { dadosAnexo: documentoData, prompt }, config);
    const cacheHit = cacheRespostas.get(chaveCache);
    if (cacheHit) {
      registrador.info(`[Cache HIT] ${tipo} (${tipoDocLog}): ${chaveCache}`);
      return cacheHit;
    }
    registrador.debug(`[Cache MISS] ${tipo} (${tipoDocLog}): ${chaveCache}`);

    try {
      const configAI = {
        ...config,
        systemInstruction: config.systemInstruction || obterInstrucaoDocumento()
      };
      const modelo = obterOuCriarModelo(configAI);
      const parteDoc = { inlineData: { mimeType: mimeType, data: documentoData.data } };
      const promptTexto = prompt || `Analise este documento (${tipoDocLog}) e forneça um resumo.`;
      const partesConteudo = [parteDoc, { text: promptTexto }];

      // Usar timeout maior para documentos inline
      const resultado = await executarComResiliencia('processarDocumentoInline', () => modelo.generateContent(partesConteudo), TIMEOUT_API_UPLOAD_MS);
      const resposta = processarRespostaIA(resultado, tipoDocLog, config.dadosOrigem);

      cacheRespostas.set(chaveCache, resposta);
      // Adicionar prefixo
      return resposta;
    } catch (erro) {
      return tratarErroAPI(erro, tipoDocLog, config.dadosOrigem, { prompt, mimeType, config });
    }
  };

  // NOTA: processarDocumentoArquivo e processarVideo ainda usam GoogleAIFileManager
  // A integração com rate limiter e cache é mais complexa aqui devido ao ciclo upload->wait->process->delete

  const processarDocumentoArquivo = async (caminhoDocumento, prompt, config) => {
    const tipo = 'documentoArquivo';
    const mimeType = config.mimeType || 'application/octet-stream';
    const tipoDocLog = mimeType.split('/')[1] || 'documento';
    let nomeArquivoGoogle = null;

    // --- Cache Check (Baseado no conteúdo do arquivo) ---
    let chaveCache;
    try {
      chaveCache = await criarChaveCache(tipo, { caminhoArquivo: caminhoDocumento, prompt }, config);
      const cacheHit = cacheRespostas.get(chaveCache);
      if (cacheHit) {
        registrador.info(`[Cache HIT] ${tipo} (${tipoDocLog}): ${chaveCache}`);
        return cacheHit;
      }
      registrador.debug(`[Cache MISS] ${tipo} (${tipoDocLog}): ${chaveCache}`);
    } catch (err) {
      registrador.warn(`[Cache] Erro ao gerar chave para ${tipo} ${caminhoDocumento}: ${err.message}. Cache desativado para esta requisição.`);
      chaveCache = null; // Desativa cache se não puder gerar chave
    }
    // --- Fim Cache Check ---

    try {
      registrador.info(`[${tipo}] Iniciando processamento: ${caminhoDocumento}`);
      let mimeTypeParaUpload = mimeType === 'application/octet-stream' ? 'text/plain' : mimeType;

      // --- Upload com Rate Limiter e Resiliência ---
      const respostaUpload = await executarComResiliencia(
        'uploadFileDoc',
        () => gerenciadorArquivosGoogle.uploadFile(caminhoDocumento, {
          mimeType: mimeTypeParaUpload,
          displayName: path.basename(caminhoDocumento) || `${tipoDocLog.toUpperCase()} Enviado`
        }),
        TIMEOUT_API_UPLOAD_MS // Timeout maior para upload
      );
      nomeArquivoGoogle = respostaUpload.file.name;
      registrador.info(`[${tipo}] Upload concluído: ${nomeArquivoGoogle} (Mimetype Upload: ${mimeTypeParaUpload})`);
      // --- Fim Upload ---

      // --- Espera pelo Processamento (com Rate Limiter no getFile) ---
      let arquivo;
      let tentativasEspera = 0;
      const maxTentativasEspera = 15;
      const tempoEsperaPolling = 10000;

      do {
        registrador.info(`[${tipo}] [${nomeArquivoGoogle}] Aguardando processamento... (tentativa ${tentativasEspera + 1}/${maxTentativasEspera})`);
        await new Promise(resolve => setTimeout(resolve, tempoEsperaPolling));
        // Usar executarComResiliencia para o polling também, pois é uma chamada de API
        arquivo = await executarComResiliencia(
           'getFileDoc',
           () => gerenciadorArquivosGoogle.getFile(nomeArquivoGoogle)
        );
        tentativasEspera++;
      } while (arquivo.state === "PROCESSING" && tentativasEspera < maxTentativasEspera);
      // --- Fim Espera ---

      if (arquivo.state === "FAILED" || (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE")) {
        throw new Error(`Falha ou estado inesperado (${arquivo.state}) no processamento do arquivo ${tipoDocLog} [${nomeArquivoGoogle}] pelo Google AI`);
      }
      registrador.info(`[${tipo}] [${nomeArquivoGoogle}] Pronto para análise. Estado: ${arquivo.state}`);

      // --- Geração de Conteúdo com Rate Limiter e Resiliência ---
      const configAI = { ...config, systemInstruction: config.systemInstruction || obterInstrucaoDocumento() };
      const modelo = obterOuCriarModelo(configAI);
      const promptTexto = prompt || `Analise este documento (${tipoDocLog}) e forneça um resumo.`;
      const partesConteudo = [{ fileData: { mimeType: arquivo.mimeType, fileUri: arquivo.uri } }, { text: promptTexto }];

      const resultado = await executarComResiliencia(
        'generateContentDocArquivo',
        () => modelo.generateContent(partesConteudo),
        TIMEOUT_API_UPLOAD_MS // Timeout maior
      );
      const resposta = processarRespostaIA(resultado, tipoDocLog, config.dadosOrigem);
      // --- Fim Geração ---

      // Adicionar ao cache se a chave foi gerada
      if (chaveCache) {
        cacheRespostas.set(chaveCache, resposta);
      }

      // Adicionar prefixo
      return resposta;

    } catch (erro) {
      return tratarErroAPI(erro, tipoDocLog, config.dadosOrigem, { caminhoDocumento, prompt, mimeType, config });
    } finally {
      // --- Limpeza do Arquivo (com Rate Limiter e Resiliência) ---
      if (nomeArquivoGoogle) {
        try {
          registrador.info(`[${tipo}] Tentando deletar arquivo [${nomeArquivoGoogle}] do Google AI.`);
          await executarComResiliencia(
            'deleteFileDoc',
            () => gerenciadorArquivosGoogle.deleteFile(nomeArquivoGoogle)
          );
          registrador.info(`[${tipo}] Arquivo [${nomeArquivoGoogle}] deletado com sucesso.`);
        } catch (deleteError) {
          registrador.error(`[${tipo}] Erro ao deletar arquivo [${nomeArquivoGoogle}] do Google AI: ${deleteError.message}`);
        }
      }
      // --- Fim Limpeza ---
    }
  };

  const processarVideo = async (caminhoVideo, prompt, config) => {
     const tipo = 'video';
     const mimeType = config.mimeType || 'video/mp4'; // Assumir mp4 como padrão
     let nomeArquivoGoogle = null;

     // --- Cache Check ---
     let chaveCache;
     try {
       chaveCache = await criarChaveCache(tipo, { caminhoArquivo: caminhoVideo, prompt }, config);
       const cacheHit = cacheRespostas.get(chaveCache);
       if (cacheHit) {
         registrador.info(`[Cache HIT] ${tipo}: ${chaveCache}`);
         return cacheHit;
       }
       registrador.debug(`[Cache MISS] ${tipo}: ${chaveCache}`);
     } catch (err) {
       registrador.warn(`[Cache] Erro ao gerar chave para ${tipo} ${caminhoVideo}: ${err.message}. Cache desativado.`);
       chaveCache = null;
     }
     // --- Fim Cache Check ---

     try {
       registrador.info(`[${tipo}] Iniciando processamento: ${caminhoVideo}`);

       // --- Upload ---
       const respostaUpload = await executarComResiliencia(
         'uploadFileVideo',
         () => gerenciadorArquivosGoogle.uploadFile(caminhoVideo, {
           mimeType: mimeType,
           displayName: path.basename(caminhoVideo) || "Vídeo Enviado"
         }),
         TIMEOUT_API_UPLOAD_MS
       );
       nomeArquivoGoogle = respostaUpload.file.name;
       registrador.info(`[${tipo}] Upload concluído: ${nomeArquivoGoogle}`);
       // --- Fim Upload ---

       // --- Espera ---
       let arquivo;
       let tentativasEspera = 0;
       const maxTentativasEspera = 18; // Mais tempo para vídeo
       const tempoEsperaPolling = 10000;
       do {
         registrador.info(`[${tipo}] [${nomeArquivoGoogle}] Aguardando processamento... (tentativa ${tentativasEspera + 1}/${maxTentativasEspera})`);
         await new Promise(resolve => setTimeout(resolve, tempoEsperaPolling));
         arquivo = await executarComResiliencia(
            'getFileVideo',
            () => gerenciadorArquivosGoogle.getFile(nomeArquivoGoogle)
         );
         tentativasEspera++;
       } while (arquivo.state === "PROCESSING" && tentativasEspera < maxTentativasEspera);
       // --- Fim Espera ---

       if (arquivo.state === "FAILED" || (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE")) {
         throw new Error(`Falha ou estado inesperado (${arquivo.state}) no processamento do vídeo [${nomeArquivoGoogle}] pelo Google AI`);
       }
       registrador.info(`[${tipo}] [${nomeArquivoGoogle}] Pronto para análise. Estado: ${arquivo.state}`);

       // --- Geração ---
       const modoLegenda = config.modoDescricao === 'legenda' || config.usarLegenda === true;
       const promptTexto = modoLegenda ? (prompt || obterPromptVideoLegenda()) : (prompt || "Analise este vídeo e forneça um resumo.");
       const configAI = { ...config, systemInstruction: config.systemInstruction || obterInstrucaoPadrao() }; // Usar instrução padrão ou específica se houver
       const modelo = obterOuCriarModelo(configAI);
       const partesConteudo = [{ fileData: { mimeType: arquivo.mimeType, fileUri: arquivo.uri } }, { text: promptTexto }];

       const resultado = await executarComResiliencia(
         'generateContentVideo',
         () => modelo.generateContent(partesConteudo),
         TIMEOUT_API_UPLOAD_MS // Timeout maior
       );
       const resposta = processarRespostaIA(resultado, tipo, config.dadosOrigem);
       // --- Fim Geração ---

       if (chaveCache) {
         cacheRespostas.set(chaveCache, resposta);
       }

       // Adicionar prefixo
       const prefixo = modoLegenda ? "[Transcrição de Vídeo]\n\n" : "[Descrição de Vídeo]\n\n";
       return `${prefixo}${resposta}`;

     } catch (erro) {
       return tratarErroAPI(erro, tipo, config.dadosOrigem, { caminhoVideo, prompt, mimeType, config });
     } finally {
       // --- Limpeza ---
       if (nomeArquivoGoogle) {
         try {
           registrador.info(`[${tipo}] Tentando deletar arquivo [${nomeArquivoGoogle}] do Google AI.`);
           await executarComResiliencia(
             'deleteFileVideo',
             () => gerenciadorArquivosGoogle.deleteFile(nomeArquivoGoogle)
           );
           registrador.info(`[${tipo}] Arquivo [${nomeArquivoGoogle}] deletado com sucesso.`);
         } catch (deleteError) {
           registrador.error(`[${tipo}] Erro ao deletar arquivo [${nomeArquivoGoogle}] do Google AI: ${deleteError.message}`);
         }
       }
       // --- Fim Limpeza ---
     }
  };

  // --- Funções Auxiliares para Gerenciamento de Arquivos Google ---

  const uploadArquivoGoogle = async (caminhoArquivo, opcoesUpload, timeoutMs = TIMEOUT_API_UPLOAD_MS) => {
    registrador.debug(`[AdpAI] Iniciando upload Google: ${caminhoArquivo}`);
    return executarComResiliencia(
      'uploadArquivoGoogle',
      () => gerenciadorArquivosGoogle.uploadFile(caminhoArquivo, opcoesUpload),
      timeoutMs
    );
  };

  const deleteArquivoGoogle = async (nomeArquivoGoogle, timeoutMs = TIMEOUT_API_GERAL_MS) => {
    if (!nomeArquivoGoogle) return; // Não fazer nada se não houver nome
    registrador.debug(`[AdpAI] Iniciando delete Google: ${nomeArquivoGoogle}`);
    try {
      await executarComResiliencia(
        'deleteArquivoGoogle',
        () => gerenciadorArquivosGoogle.deleteFile(nomeArquivoGoogle),
        timeoutMs
      );
      registrador.info(`[AdpAI] Arquivo Google deletado: ${nomeArquivoGoogle}`);
    } catch (erro) {
      registrador.error(`[AdpAI] Falha ao deletar arquivo Google ${nomeArquivoGoogle}: ${erro.message}`);
      // Não relançar o erro para não interromper o fluxo principal se a exclusão falhar
    }
  };

  const getArquivoGoogle = async (nomeArquivoGoogle, timeoutMs = TIMEOUT_API_GERAL_MS) => {
     registrador.debug(`[AdpAI] Obtendo estado arquivo Google: ${nomeArquivoGoogle}`);
     return executarComResiliencia(
        'getArquivoGoogle',
        () => gerenciadorArquivosGoogle.getFile(nomeArquivoGoogle),
        timeoutMs
     );
  };

  /**
   * Gera conteúdo a partir de um arquivo já existente no Google AI (via URI).
   * Usado pelas filas após o upload e processamento inicial.
   */
  const gerarConteudoDeArquivoUri = async (fileUri, mimeType, prompt, config) => {
    const tipo = config.tipoMidia || 'arquivoUri';
    registrador.debug(`[${tipo}] Iniciando geração de conteúdo: ${fileUri}`);

    try {
      // Determinar instrução do sistema apropriada
      let systemInstruction = obterInstrucaoPadrao();
      if (tipo === 'video') {
        systemInstruction = config.modoDescricao === 'legenda' ? obterPromptVideoLegenda() : obterInstrucaoPadrao(); // Ou instrução específica de vídeo se houver
      } else if (tipo === 'documentoArquivo') {
        systemInstruction = obterInstrucaoDocumento();
      }
      // Adicionar mais tipos se necessário

      const configAI = { ...config, systemInstruction };
      const modelo = obterOuCriarModelo(configAI); // Usa a função interna
      const partesConteudo = [{ fileData: { mimeType: mimeType, fileUri: fileUri } }, { text: prompt }];

      const resultado = await executarComResiliencia(
        `generateContent${_.capitalize(tipo)}`, // Nome dinâmico para log
        () => modelo.generateContent(partesConteudo),
        TIMEOUT_API_UPLOAD_MS // Usar timeout maior para análise de arquivos
      );
      const resposta = processarRespostaIA(resultado, tipo, config.dadosOrigem);

      // Adicionar prefixo se necessário (exemplo para vídeo)
      if (tipo === 'video') {
        const prefixo = config.modoDescricao === 'legenda' ? "[Transcrição de Vídeo]\n\n" : "[Descrição de Vídeo]\n\n";
        return `${prefixo}${resposta}`;
      }
      // Adicionar prefixos para outros tipos se necessário

      return resposta;

    } catch (erro) {
      return tratarErroAPI(erro, tipo, config.dadosOrigem, { fileUri, mimeType, prompt, config });
    }
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
