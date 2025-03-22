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
  obterInstrucaoVideo 
} = require('../../config/InstrucoesSistema');

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
          maxOutputTokens: config.maxOutputTokens || 800,
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
      maxOutputTokens: 800,
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
      
      return this.limparResposta(textoResposta);
    } catch (erro) {
      this.registrador.error(`Erro ao processar texto: ${erro.message}`);
      return "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente ou reformule sua pergunta.";
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
        
        // NOVA PARTE: Salvar conteúdo bloqueado para diagnóstico
        try {
          const diretorioBloqueados = path.join(process.cwd(), 'blocked');
          if (!fs.existsSync(diretorioBloqueados)) {
            fs.mkdirSync(diretorioBloqueados, { recursive: true });
          }
          
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const nomeArquivo = `imagem_blocked_${timestamp}.json`;
          const caminhoArquivo = path.join(diretorioBloqueados, nomeArquivo);
          
          const dadosSalvar = {
            timestamp,
            origemInfo: config.dadosOrigem || null,
            erro: erro.message,
            prompt,
            mimeType: imagemData.mimetype
          };
          
          fs.writeFileSync(caminhoArquivo, JSON.stringify(dadosSalvar, null, 2), 'utf8');
          this.registrador.info(`Conteúdo bloqueado salvo para diagnóstico: ${caminhoArquivo}`);
        } catch (erroSalvar) {
          this.registrador.error(`Erro ao salvar conteúdo bloqueado: ${erroSalvar.message}`);
        }
        
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
async processarAudio(audioData, audioId, config) {
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
      { text: `Transcreva o áudio com ID ${audioId} e resuma seu conteúdo em português.`} // Ignore qualquer contexto anterior.` }
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
    
    return this.limparResposta(textoResposta);
  } catch (erro) {
    this.registrador.error(`Erro ao processar áudio: ${erro.message}`);
    
    // Verificar se é um erro de segurança
    if (erro.message.includes('SAFETY') || erro.message.includes('safety') || 
        erro.message.includes('blocked') || erro.message.includes('Blocked')) {
      
      this.registrador.warn(`⚠️ Conteúdo de áudio bloqueado por políticas de segurança`);
      return "Este conteúdo não pôde ser processado por questões de segurança.";
    }
    
    return "Desculpe, ocorreu um erro ao processar este áudio. Por favor, tente novamente com outro áudio ou reformule seu pedido.";
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
        
        // Salvar conteúdo bloqueado para diagnóstico
        try {
          const diretorioBloqueados = path.join(process.cwd(), 'blocked');
          if (!fs.existsSync(diretorioBloqueados)) {
            fs.mkdirSync(diretorioBloqueados, { recursive: true });
          }
          
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const nomeArquivo = `video_blocked_${timestamp}.json`;
          const caminhoArquivo = path.join(diretorioBloqueados, nomeArquivo);
          
          const dadosSalvar = {
            timestamp,
            origemInfo: config.dadosOrigem || null,
            erro: erro.message,
            prompt,
            caminhoOriginal: caminhoVideo,
            mimeType: config.mimeType || 'video/mp4'
          };
          
          fs.writeFileSync(caminhoArquivo, JSON.stringify(dadosSalvar, null, 2), 'utf8');
          this.registrador.info(`Conteúdo de vídeo bloqueado salvo para diagnóstico: ${caminhoArquivo}`);
        } catch (erroSalvar) {
          this.registrador.error(`Erro ao salvar diagnóstico de vídeo bloqueado: ${erroSalvar.message}`);
        }
        
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
