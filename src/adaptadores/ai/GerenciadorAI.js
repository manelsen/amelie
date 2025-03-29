/**
 * GerenciadorAI - Gerencia a interação com modelos de IA
 * 
 * Este módulo encapsula toda a interação com a API do Google Generative AI,
 * incluindo cache de modelos, tratamento de erros e timeout.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const crypto = require('crypto');
const IAPort = require('../../portas/IAPort');
const fs = require('fs');
const path = require('path');
const { 
  obterInstrucaoPadrao,
  obterInstrucaoAudio,
  obterInstrucaoImagem,
  obterInstrucaoDocumento, // Importar a função renomeada/generalizada
  obterPromptVideoLegenda // Mantendo import existente
} = require('../../config/InstrucoesSistema');
const { salvarConteudoBloqueado } = require('../../utilitarios/ArquivoUtils');

class GerenciadorAI extends IAPort {
  /**
   * Cria uma instância do gerenciador de IA
   * @param {Object} registrador - Objeto logger para registro de eventos
   * @param {string} apiKey - Chave da API do Google Generative AI
   */
  constructor(registrador, apiKey) {
    super();
    this.registrador = registrador;
    this.apiKey = apiKey;
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.gerenciadorArquivos = new GoogleAIFileManager(apiKey);
    this.cacheModelos = new Map();
    this.disjuntor = this.criarDisjuntor();
  }

  /**
   * Cria um disjuntor para proteção contra falhas na API
   * @returns {Object} Objeto disjuntor
   */
  criarDisjuntor() {
    return {
      falhas: 0,
      ultimaFalha: 0,
      estado: 'FECHADO', // FECHADO, ABERTO, SEMI_ABERTO
      limite: 5, // Número de falhas para abrir o circuito
      tempoReset: 60000, // 1 minuto para resetar
      
      registrarSucesso() {
        this.falhas = 0;
        this.estado = 'FECHADO';
      },
      
      registrarFalha() {
        this.falhas++;
        this.ultimaFalha = Date.now();
        
        if (this.falhas >= this.limite) {
          this.estado = 'ABERTO';
          return true; // Circuito aberto
        }
        return false; // Circuito ainda fechado
      },
      
      podeExecutar() {
        if (this.estado === 'FECHADO') return true;
        
        if (this.estado === 'ABERTO') {
          if (Date.now() - this.ultimaFalha > this.tempoReset) {
            this.estado = 'SEMI_ABERTO';
            return true;
          }
          return false;
        }
        
        return true;
      }
    };
  }

  /**
   * Gera uma chave única para cache de modelos
   * @param {Object} config - Configurações do modelo
   * @returns {string} Chave de cache
   */
  obterChaveCacheModelo(config) {
    const {
      model = "gemini-2.0-flash",
      temperature = 0.9,
      topK = 1,
      topP = 0.95,
      maxOutputTokens = 1024,
      systemInstruction = obterInstrucaoPadrao()
    } = config;
    
    return `${model}_${temperature}_${topK}_${topP}_${maxOutputTokens}_${crypto.createHash('md5').update(systemInstruction || '').digest('hex')}`;
  }

    /**
   * Obtém configurações para processamento de imagem/vídeo diretamente do banco
   * @param {string} chatId - ID do chat
   * @param {string} tipo - Tipo de mídia ('imagem' ou 'video')
   * @returns {Promise<Object>} Configurações do processamento
   */
  async obterConfigDireta(chatId, tipo = 'imagem') {
    try {
      // Importar ConfigManager
      const caminhoConfig = path.resolve(__dirname, '../../config/ConfigManager');
      const ConfigManager = require(caminhoConfig);
      
      // Criar instância temporária para acessar o banco
      const gerenciadorConfig = new ConfigManager(this.registrador, path.join(process.cwd(), 'db'));
      
      // Obter configuração do banco
      const config = await gerenciadorConfig.obterConfig(chatId);
      
      // Log para depuração
      this.registrador.debug(`GerenciadorAI - Config direta para ${chatId}: modo=${config.modoDescricao || 'não definido'}`);
      
      return config;
    } catch (erro) {
      this.registrador.error(`Erro ao obter configuração direta: ${erro.message}`);
      // Retornar configuração padrão em caso de erro
      return { modoDescricao: 'curto' };
    }
  }

   /**
   * Obtém configurações para processamento de imagem/vídeo diretamente do banco
   * @param {string} chatId - ID do chat específico para obter a configuração
   * @param {string} tipo - Tipo de mídia ('imagem' ou 'video')
   * @returns {Promise<Object>} Configurações do processamento
   */
  async obterConfigDireta(chatId, tipo = 'imagem') {
    try {
      // Importar ConfigManager
      const caminhoConfig = path.resolve(__dirname, '../../config/ConfigManager');
      const ConfigManager = require(caminhoConfig);
      
      // Criar instância temporária para acessar o banco
      const gerenciadorConfig = new ConfigManager(this.registrador, path.join(process.cwd(), 'db'));
      
      // Obter configuração do banco
      const config = await gerenciadorConfig.obterConfig(chatId);
      
      // Log para depuração
      this.registrador.debug(`GerenciadorAI - Config direta para ${chatId}: modo=${config.modoDescricao || 'não definido'}`);
      
      return config;
    } catch (erro) {
      this.registrador.error(`Erro ao obter configuração direta: ${erro.message}`);
      // Retornar configuração padrão em caso de erro
      return { modoDescricao: 'curto' };
    }
  }

  /**
   * Obtém configurações para processamento de imagem
   * @param {string} chatId - ID do chat
   * @returns {Promise<Object>} Configurações do processamento
   */
  async obterConfigProcessamento(chatId) {
    try {
      // Tentar obter configurações do gerenciador
      if (this.gerenciadorConfig) {
        const config = await this.gerenciadorConfig.obterConfig(chatId);
        
        // Obter o modo de descrição
        const modoDescricao = config.modoDescricao || 'longo';
        
        // Ajustar as instruções de sistema com base no modo
        let sistemInstructions;
        if (modoDescricao === 'curto') {
          sistemInstructions = obterInstrucaoImagemCurta();
        } else {
          sistemInstructions = obterInstrucaoImagem();
        }
        
        return {
          temperature: config.temperature || 0.7,
          topK: config.topK || 1,
          topP: config.topP || 0.95,
          maxOutputTokens: config.maxOutputTokens || 1024,
          model: config.model || "gemini-2.0-flash",
          systemInstructions: sistemInstructions,
          modoDescricao
        };
      }
    } catch (erro) {
      this.registrador.warn(`Erro ao obter configurações: ${erro.message}, usando padrão`);
    }
    
    // Configuração padrão
    return {
      temperature: 0.7,
      topK: 1,
      topP: 0.95,
      maxOutputTokens: 1024,
      model: "gemini-2.0-flash", // Usar o modelo rápido para imagens simples
      systemInstructions: obterInstrucaoImagem(),
      modoDescricao: 'curto'
    };
  }
  
  /**
   * Obtém ou cria um modelo com as configurações especificadas
   * @param {Object} config - Configurações do modelo
   * @returns {Object} Instância do modelo
   */
  obterOuCriarModelo(config) {
    if (!this.disjuntor.podeExecutar()) {
      this.registrador.warn(`Requisição de modelo bloqueada pelo circuit breaker (estado: ${this.disjuntor.estado})`);
      throw new Error("Serviço temporariamente indisponível - muitas falhas recentes");
    }
    
    const chaveCache = this.obterChaveCacheModelo(config);
    
    if (this.cacheModelos.has(chaveCache)) {
      this.registrador.debug(`Usando modelo em cache com chave: ${chaveCache}`);
      return this.cacheModelos.get(chaveCache);
    }
    
    this.registrador.debug(`Criando novo modelo com chave: ${chaveCache}`);
    try {
      const novoModelo = this.genAI.getGenerativeModel({
        model: config.model || "gemini-2.0-flash",
        generationConfig: {
          temperature: config.temperature || 0.9,
          topK: config.topK || 1,
          topP: config.topP || 0.95,
          maxOutputTokens: config.maxOutputTokens || 1024,
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ],
        systemInstruction: config.systemInstruction || obterInstrucaoPadrao()
      });
      
      this.disjuntor.registrarSucesso();
      this.cacheModelos.set(chaveCache, novoModelo);
      
      if (this.cacheModelos.size > 10) {
        const chaveAntiga = Array.from(this.cacheModelos.keys())[0];
        this.cacheModelos.delete(chaveAntiga);
        this.registrador.debug(`Cache de modelos atingiu o limite. Removendo modelo mais antigo: ${chaveAntiga}`);
      }
      
      return novoModelo;
    } catch (erro) {
      const circuitoAberto = this.disjuntor.registrarFalha();
      if (circuitoAberto) {
        this.registrador.error(`Circuit breaker aberto após múltiplas falhas!`);
      }
      throw erro;
    }
  }

  /**
   * Implementação do método processarTexto da interface IAPort
   * @param {string} texto - Texto para processar
   * @param {Object} config - Configurações de processamento
   * @returns {Promise<string>} Resposta gerada
   */
  async processarTexto(texto, config) {
    let tentativas = 0;
    const maxTentativas = 5;
    const tempoEspera = 2000; // 2 segundos iniciais
    
    while (tentativas < maxTentativas) {
      try {
        const modelo = this.obterOuCriarModelo(config);
        
        // Adicionar timeout de 45 segundos
        const promessaResultado = modelo.generateContent(texto);
        const promessaTimeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Timeout da API Gemini")), 90000)
        );
        
        const resultado = await Promise.race([promessaResultado, promessaTimeout]);
        let textoResposta = resultado.response.text();
        
        if (!textoResposta) {
          throw new Error('Resposta vazia gerada pelo modelo');
        }
        
        // Registrar sucesso no circuit breaker
        this.disjuntor.registrarSucesso();
        
        return this.limparResposta(textoResposta);
      } catch (erro) {
        tentativas++;
        
        // Verificar se é erro 503
        if (erro.message.includes('503 Service Unavailable')) {
          this.registrador.warn(`API do Google indisponível (503), tentativa ${tentativas}/${maxTentativas}`);
          
          // Se não for a última tentativa, aguardar com backoff exponencial
          if (tentativas < maxTentativas) {
            const tempoEsperaAtual = tempoEspera * Math.pow(2, tentativas - 1);
            this.registrador.info(`Aguardando ${tempoEsperaAtual}ms antes da próxima tentativa...`);
            await new Promise(resolve => setTimeout(resolve, tempoEsperaAtual));
            continue;
          }
        }
        
        this.registrador.error(`Erro ao processar texto: ${erro.message}`);
        
        // Registrar falha no circuit breaker
        this.disjuntor.registrarFalha();
        
        return "Desculpe, o serviço de IA está temporariamente indisponível. Por favor, tente novamente em alguns instantes.";
      }
    }
  }
  

  /**
 * Implementação do método processarImagem da interface IAPort
 * @param {Object} imagemData - Dados da imagem
 * @param {string} prompt - Instruções para processamento
 * @param {Object} config - Configurações de processamento
 * @returns {Promise<string>} Resposta gerada
 */
async processarImagem(imagemData, prompt, config) {
  try {
    const modelo = this.obterOuCriarModelo({
      ...config,
      // Instruções específicas para descrição
      systemInstruction: config.systemInstructions || obterInstrucaoImagem()
    });
    
    const parteImagem = {
      inlineData: {
        data: imagemData.data,
        mimeType: imagemData.mimetype
      }
    };
    
    const partesConteudo = [
      parteImagem,
      { text: prompt }
    ];
    
    // Adicionar timeout de 45 segundos
    const promessaResultado = modelo.generateContent(partesConteudo);
    const promessaTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Timeout da API Gemini")), 90000)
    );
    
    const resultado = await Promise.race([promessaResultado, promessaTimeout]);
    let textoResposta = resultado.response.text();
    
    if (!textoResposta) {
      throw new Error('Resposta vazia gerada pelo modelo');
    }
    
    return this.limparResposta(textoResposta);
  } catch (erro) {
    // Aqui adicionamos informações do usuário/grupo no log
    const origemInfo = config.dadosOrigem ? 
      `[Origem: ${config.dadosOrigem.tipo === 'grupo' ? 'Grupo' : 'Usuário'} "${config.dadosOrigem.nome}" (${config.dadosOrigem.id})]` : 
      '[Origem desconhecida]';
    
    // Verificar se é erro de safety
    if (erro.message.includes('SAFETY') || erro.message.includes('safety') || 
        erro.message.includes('blocked') || erro.message.includes('Blocked')) {
      
      this.registrador.warn(`⚠️ Conteúdo de imagem bloqueado por políticas de segurança ${origemInfo}`);
      
      // NOVA PARTE: Salvar conteúdo bloqueado para auditoria
      const diretorioBloqueados = path.join(process.cwd(), 'blocked');
      const salvarImagemBloqueada = salvarConteudoBloqueado('imagem', diretorioBloqueados);
      
      // Executar salvamento, mas não aguardar para continuar o fluxo principal
      salvarImagemBloqueada({
        origemInfo: config.dadosOrigem,
        prompt,
        mimeType: imagemData.mimetype,
        imagemData
      }, erro).then(resultado => {
        if (resultado.sucesso) {
          this.registrador.info(`Conteúdo bloqueado salvo para auditoria: ${resultado.dados.caminhoJson}`);
        }
      }).catch(erroSalvar => {
        this.registrador.error(`Erro ao salvar conteúdo bloqueado: ${erroSalvar.message}`);
      });
      
      return "Este conteúdo não pôde ser processado por questões de segurança.";
    }
    
    this.registrador.error(`Erro ao processar imagem: ${erro.message} ${origemInfo}`);
    return "Desculpe, ocorreu um erro ao analisar esta imagem. Por favor, tente novamente com outra imagem ou reformule seu pedido.";
  }
}

/**
 * Implementação do método processarAudio da interface IAPort
 * @param {Object} audioData - Dados do áudio
 * @param {string} audioId - Identificador único do áudio
 * @param {Object} config - Configurações de processamento
 * @returns {Promise<string>} Resposta gerada
 */
/**
 * Implementação do método processarAudio da interface IAPort
 * @param {Object} audioData - Dados do áudio
 * @param {string} audioId - Identificador único do áudio
 * @param {Object} config - Configurações de processamento
 * @returns {Promise<string>} Resposta gerada
 */
async processarAudio(audioData, audioId, config) {
  let tentativas = 0;
  const maxTentativas = 5;
  const tempoEspera = 2000; // 2 segundos iniciais
  
  while (tentativas < maxTentativas) {
    try {
      const modelo = this.obterOuCriarModelo({
        ...config,
        temperature: 0.3, // Menor temperatura para transcrição mais precisa
        systemInstruction: config.systemInstructions || obterInstrucaoAudio()
      });
      
      const arquivoAudioBase64 = audioData.data;
      
      const partesConteudo = [
        {
          inlineData: {
            mimeType: audioData.mimetype,
            data: arquivoAudioBase64
          }
        },
        { text: `Transcreva o áudio com ID ${audioId} e resuma seu conteúdo em português.`}
      ];
      
      // Adicionar timeout
      const promessaResultado = modelo.generateContent(partesConteudo);
      const promessaTimeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout da API Gemini")), 60000)
      );
      
      const resultado = await Promise.race([promessaResultado, promessaTimeout]);
      let textoResposta = resultado.response.text();
      
      if (!textoResposta) {
        throw new Error('Resposta vazia gerada pelo modelo');
      }
      
      // Registrar sucesso no circuit breaker
      this.disjuntor.registrarSucesso();
      
      return this.limparResposta(textoResposta);
      
    } catch (erro) {
      tentativas++;
      
      // Verificar se é erro 503
      if (erro.message.includes('503 Service Unavailable')) {
        this.registrador.warn(`API do Google indisponível (503), tentativa ${tentativas}/${maxTentativas}`);
        
        // Se não for a última tentativa, aguardar com backoff exponencial
        if (tentativas < maxTentativas) {
          const tempoEsperaAtual = tempoEspera * Math.pow(2, tentativas - 1);
          this.registrador.info(`Aguardando ${tempoEsperaAtual}ms antes da próxima tentativa...`);
          await new Promise(resolve => setTimeout(resolve, tempoEsperaAtual));
          continue;
        }
      }
      
      this.registrador.error(`Erro ao processar áudio: ${erro.message}`);
      
      // Registrar falha no circuit breaker
      this.disjuntor.registrarFalha();
      
      // Verificar se é um erro de segurança
      if (erro.message.includes('SAFETY') || erro.message.includes('safety') || 
          erro.message.includes('blocked') || erro.message.includes('Blocked')) {
        
        this.registrador.warn(`⚠️ Conteúdo de áudio bloqueado por políticas de segurança`);
        return "Este conteúdo não pôde ser processado por questões de segurança.";
      }
      
      return "Desculpe, o serviço de IA está temporariamente indisponível. Por favor, tente novamente em alguns instantes.";
    }
  }
}


  /**
   * Implementação do método processarDocumentoArquivo da interface IAPort (generalizado)
   * @param {string} caminhoDocumento - Caminho para o arquivo (PDF, TXT, HTML, etc.)
   * @param {string} prompt - Instruções de processamento (pode vir da legenda)
   * @param {Object} config - Configurações de processamento (inclui mimeType)
   * @returns {Promise<string>} Resposta gerada
   */
  async processarDocumentoArquivo(caminhoDocumento, prompt, config) {
    let nomeArquivoGoogle = null; // Para garantir a limpeza
    const mimeType = config.mimeType || 'application/octet-stream'; // Obter mimetype do config
    const tipoDoc = mimeType.split('/')[1] || 'documento'; // Extrair tipo para logs

    try {
      this.registrador.info(`Iniciando processamento de ${tipoDoc}: ${caminhoDocumento}`);
      // Fazer upload para o Google AI
      const respostaUpload = await this.gerenciadorArquivos.uploadFile(caminhoDocumento, {
        mimeType: mimeType, // Usar o mimetype correto
        displayName: path.basename(caminhoDocumento) || `${tipoDoc.toUpperCase()} Enviado`
      });
      nomeArquivoGoogle = respostaUpload.file.name; // Guardar nome para limpeza
      this.registrador.info(`${tipoDoc.toUpperCase()} enviado para Google AI com nome: ${nomeArquivoGoogle}`);

      // Aguardar processamento
      let arquivo = await this.gerenciadorArquivos.getFile(nomeArquivoGoogle);
      let tentativas = 0;
      const maxTentativasEspera = 15; // Manter espera
      const tempoEspera = 10000; // 10 segundos

      while (arquivo.state === "PROCESSING" && tentativas < maxTentativasEspera) {
        this.registrador.info(`${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] ainda em processamento, aguardando... (tentativa ${tentativas + 1}/${maxTentativasEspera})`);
        await new Promise(resolve => setTimeout(resolve, tempoEspera));
        arquivo = await this.gerenciadorArquivos.getFile(nomeArquivoGoogle);
        tentativas++;
      }

      if (arquivo.state === "FAILED") {
        this.registrador.error(`Falha no processamento do ${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] pelo Google AI. Estado: ${arquivo.state}`);
        throw new Error(`Falha no processamento do ${tipoDoc.toUpperCase()} pelo Google AI`);
      }

      // Estados válidos para prosseguir: SUCCEEDED ou ACTIVE
      if (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE") {
        this.registrador.error(`Estado inesperado do arquivo ${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}]: ${arquivo.state}`);
        throw new Error(`Estado inesperado do arquivo ${tipoDoc.toUpperCase()}: ${arquivo.state}`);
      }

      this.registrador.info(`${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] pronto para análise. Estado: ${arquivo.state}`);

      // Obter modelo, usando instrução de DOCUMENTO padrão (que será renomeada)
      const modeloConfig = {
        ...config,
        // Usaremos obterInstrucaoDocumento que será renomeada/criada
        systemInstruction: config.systemInstruction || obterInstrucaoDocumento()
      };
      const modelo = this.obterOuCriarModelo(modeloConfig);

      // Preparar partes de conteúdo
      const partesConteudo = [
        {
          fileData: {
            mimeType: arquivo.mimeType,
            fileUri: arquivo.uri
          }
        },
        {
          // Usar o prompt fornecido ou um prompt genérico se vazio
          text: prompt || `Analise este documento (${tipoDoc}) e forneça um resumo.`
        }
      ];

      // Adicionar timeout para a chamada à IA
      const timeoutMs = 180000; // 3 minutos (manter)
      this.registrador.info(`Chamando modelo Gemini para ${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] com timeout de ${timeoutMs}ms`);
      const promessaRespostaIA = modelo.generateContent(partesConteudo);
      const promessaTimeoutIA = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Tempo esgotado (${timeoutMs}ms) na análise de ${tipoDoc}`)), timeoutMs)
      );

      const resultado = await Promise.race([promessaRespostaIA, promessaTimeoutIA]);
      let resposta = resultado.response.text();

      if (!resposta || typeof resposta !== 'string' || resposta.trim() === '') {
        this.registrador.warn(`Resposta vazia ou inválida recebida para ${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}]`);
        resposta = `Não consegui gerar uma resposta clara para este ${tipoDoc}.`;
      } else {
        this.registrador.info(`Resposta recebida com sucesso para ${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}]`);
      }

      // Limpar o arquivo do Google ANTES de retornar
      this.registrador.info(`Tentando deletar ${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] do Google AI.`);
      await this.gerenciadorArquivos.deleteFile(nomeArquivoGoogle);
      this.registrador.info(`${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] deletado com sucesso.`);
      nomeArquivoGoogle = null; // Marcar como deletado

      // Usar um emoji genérico de documento
      const respostaFinal = `📄 *Análise do seu documento (${tipoDoc}):*\n\n${this.limparResposta(resposta)}`;
      return respostaFinal;

    } catch (erro) {
      const origemInfo = config.dadosOrigem ?
        `[Origem: ${config.dadosOrigem.tipo === 'grupo' ? 'Grupo' : 'Usuário'} "${config.dadosOrigem.nome}" (${config.dadosOrigem.id})]` :
        '[Origem desconhecida]';

      // Verificar se é erro de safety
      if (erro.message.includes('SAFETY') || erro.message.includes('safety') ||
          erro.message.includes('blocked') || erro.message.includes('Blocked')) {

        this.registrador.warn(`⚠️ Conteúdo de ${tipoDoc.toUpperCase()} bloqueado por políticas de segurança ${origemInfo}. Arquivo Google: ${nomeArquivoGoogle || 'N/A'}`);

        // Salvar conteúdo bloqueado para auditoria (generalizado)
        const diretorioBloqueados = path.join(process.cwd(), 'blocked');
        const salvarDocBloqueado = salvarConteudoBloqueado(tipoDoc, diretorioBloqueados); // Usar tipoDoc

        salvarDocBloqueado({
          origemInfo: config.dadosOrigem,
          prompt,
          mimeType: mimeType, // Usar mimetype correto
          caminhoDocumento // Usar caminho correto
        }, erro).then(resultado => {
          if (resultado.sucesso) {
            this.registrador.info(`Diagnóstico de ${tipoDoc.toUpperCase()} bloqueado salvo: ${resultado.dados.caminhoJson}`);
          }
        }).catch(erroSalvar => {
          this.registrador.error(`Erro ao salvar diagnóstico de ${tipoDoc.toUpperCase()} bloqueado: ${erroSalvar.message}`);
        });

        // Limpar o arquivo do Google se ainda existir
        if (nomeArquivoGoogle) {
          try {
            this.registrador.warn(`Tentando deletar ${tipoDoc.toUpperCase()} bloqueado [${nomeArquivoGoogle}] do Google AI.`);
            await this.gerenciadorArquivos.deleteFile(nomeArquivoGoogle);
            this.registrador.info(`${tipoDoc.toUpperCase()} bloqueado [${nomeArquivoGoogle}] deletado.`);
          } catch (deleteError) {
            this.registrador.error(`Erro ao deletar ${tipoDoc.toUpperCase()} bloqueado [${nomeArquivoGoogle}] do Google AI: ${deleteError.message}`);
          }
        }

        return "Este conteúdo não pôde ser processado por questões de segurança.";
      }

      this.registrador.error(`Erro ao processar ${tipoDoc.toUpperCase()}: ${erro.message} ${origemInfo}. Arquivo Google: ${nomeArquivoGoogle || 'N/A'}`);

      // Limpar o arquivo do Google em caso de outros erros
      if (nomeArquivoGoogle) {
        try {
          this.registrador.error(`Tentando deletar ${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] do Google AI após erro.`);
          await this.gerenciadorArquivos.deleteFile(nomeArquivoGoogle);
          this.registrador.info(`${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] deletado após erro.`);
        } catch (deleteError) {
          this.registrador.error(`Erro ao deletar ${tipoDoc.toUpperCase()} [${nomeArquivoGoogle}] do Google AI após erro: ${deleteError.message}`);
        }
      }

      return `Desculpe, ocorreu um erro ao processar este ${tipoDoc}. Por favor, tente novamente.`;
    }
  }

  /**
 * Implementação do método processarVideo da interface IAPort
 * @param {string} caminhoVideo - Caminho para o arquivo de vídeo
 * @param {string} prompt - Instruções para processamento
 * @param {Object} config - Configurações de processamento
 * @returns {Promise<string>} Resposta gerada
 */
async processarVideo(caminhoVideo, prompt, config) {
  try {
    // Fazer upload para o Google AI
    const respostaUpload = await this.gerenciadorArquivos.uploadFile(caminhoVideo, {
      mimeType: config.mimeType || 'video/mp4',
      displayName: "Vídeo Enviado"
    });
    
    // Aguardar processamento
    let arquivo = await this.gerenciadorArquivos.getFile(respostaUpload.file.name);
    let tentativas = 0;
    
    while (arquivo.state === "PROCESSING" && tentativas < 12) {
      this.registrador.info(`Vídeo ainda em processamento, aguardando... (tentativa ${tentativas + 1})`);
      await new Promise(resolve => setTimeout(resolve, 10000));
      arquivo = await this.gerenciadorArquivos.getFile(respostaUpload.file.name);
      tentativas++;
    }
    
    if (arquivo.state === "FAILED") {
      throw new Error("Falha no processamento do vídeo pelo Google AI");
    }
    
    // Estados válidos para prosseguir: SUCCEEDED ou ACTIVE
    if (arquivo.state !== "SUCCEEDED" && arquivo.state !== "ACTIVE") {
      throw new Error(`Estado inesperado do arquivo: ${arquivo.state}`);
    }
    
    // Registrar informação sobre o estado do arquivo
    if (arquivo.state === "ACTIVE") {
      this.registrador.info("Arquivo ainda está ativo, mas pronto para processamento");
    }
    
    // Verificar modo legenda
    if (config.modoDescricao === 'legenda' || config.usarLegenda === true) {
      this.registrador.info('🎬👂 Processando vídeo no MODO LEGENDA para acessibilidade de surdos');
      
      // Se não tiver instruções específicas, usar o prompt de legenda
      if (!prompt.includes("timecodes") && !prompt.includes("verbatim")) {
        prompt = obterPromptVideoLegenda();
        this.registrador.info('📝 Usando prompt específico de legendagem');
      }
    }
    
    // Obter modelo
    const modelo = this.obterOuCriarModelo(config);
    
    // Preparar partes de conteúdo
    const partesConteudo = [
      {
        fileData: {
          mimeType: arquivo.mimeType,
          fileUri: arquivo.uri
        }
      },
      {
        text: prompt
      }
    ];
    
    // Adicionar timeout para a chamada à IA
    const promessaRespostaIA = modelo.generateContent(partesConteudo);
    const promessaTimeoutIA = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Tempo esgotado na análise de vídeo")), 120000)
    );
    
    const resultado = await Promise.race([promessaRespostaIA, promessaTimeoutIA]);
    let resposta = resultado.response.text();
    
    if (!resposta || typeof resposta !== 'string' || resposta.trim() === '') {
      resposta = "Não consegui gerar uma descrição clara para este vídeo.";
    }
    
    // Limpar o arquivo do Google
    await this.gerenciadorArquivos.deleteFile(respostaUpload.file.name);
    
    // Formatar o início da resposta com base no modo
    let prefixoResposta = "";
    if (config.modoDescricao === 'legenda' || config.usarLegenda === true) {
      prefixoResposta = "📋 *Transcrição com timecodes:*\n\n";
    } else {
      prefixoResposta = "✅ *Análise do seu vídeo:*\n\n";
    }
    
    const respostaFinal = `${prefixoResposta}${resposta}`;
    return respostaFinal;
  } catch (erro) {
    // NOVA PARTE: Verificar se é erro de safety
    if (erro.message.includes('SAFETY') || erro.message.includes('safety') || 
        erro.message.includes('blocked') || erro.message.includes('Blocked')) {
      
      const origemInfo = config.dadosOrigem ? 
        `[Origem: ${config.dadosOrigem.tipo === 'grupo' ? 'Grupo' : 'Usuário'} "${config.dadosOrigem.nome}" (${config.dadosOrigem.id})]` : 
        '[Origem desconhecida]';
        
      this.registrador.warn(`⚠️ Conteúdo de vídeo bloqueado por políticas de segurança ${origemInfo}`);
      
      // NOVA PARTE: Salvar conteúdo bloqueado para auditoria
      const diretorioBloqueados = path.join(process.cwd(), 'blocked');
      const salvarVideoBloqueado = salvarConteudoBloqueado('video', diretorioBloqueados);
      
      // Executar salvamento, mas não aguardar para continuar o fluxo principal
      salvarVideoBloqueado({
        origemInfo: config.dadosOrigem,
        prompt,
        mimeType: config.mimeType || 'video/mp4',
        caminhoVideo
      }, erro).then(resultado => {
        if (resultado.sucesso) {
          this.registrador.info(`Conteúdo de vídeo bloqueado salvo para auditoria: ${resultado.dados.caminhoJson}`);
        }
      }).catch(erroSalvar => {
        this.registrador.error(`Erro ao salvar diagnóstico de vídeo bloqueado: ${erroSalvar.message}`);
      });
      
      return "Este conteúdo não pôde ser processado por questões de segurança.";
    }
    
    this.registrador.error(`Erro ao processar vídeo: ${erro.message}`);
    return "Desculpe, ocorreu um erro ao processar este vídeo. Por favor, tente novamente com outro vídeo ou reformule seu pedido.";
  }
}

  /**
   * Limpa e formata a resposta da IA
   * @param {string} texto - Texto para limpar
   * @returns {string} Texto limpo
   */
  limparResposta(texto) {
    if (!texto || typeof texto !== 'string') {
      return "Não foi possível gerar uma resposta válida.";
    }
    let textoLimpo = texto
      .replace(/^(?:amélie|amelie):[\s]*/gi, '')
      .replace(/\r\n|\r|\n{2,}/g, '\n\n')
      .trim();
    return textoLimpo;
  }
}

module.exports = GerenciadorAI;
