/**
 * FilaProcessadorImagem - Gerencia filas de processamento assíncrono para imagens
 * 
 * Este módulo centraliza o gerenciamento de filas de processamento de imagens,
 * seguindo abordagem desacoplada (não envia respostas diretamente).
 */

const Queue = require('bull');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class FilaProcessadorImagem {
  /**
   * Cria uma instância do gerenciador de filas para imagens
   * @param {Object} registrador - Objeto logger para registro de eventos
   * @param {Object} gerenciadorAI - Instância do gerenciador de IA
   * @param {Object} clienteWhatsApp - Instância do cliente WhatsApp (opcional, removido do fluxo direto)
   * @param {Object} opcoes - Opções de configuração
   */
  constructor(registrador, gerenciadorAI, clienteWhatsApp, opcoes = {}) {
    this.registrador = registrador;
    this.gerenciadorAI = gerenciadorAI;
    this.clienteWhatsApp = null; // Removido acesso direto
    this.opcoes = {
      enviarRespostaDireta: false,
      ...opcoes
    };
    
    // Callback para retornar resultados ao invés de enviar diretamente
    this.respostaCallback = null;
    
    const redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379
    };
    
    // Configuração comum para todas as filas
    const defaultConfig = {
      redis: redisConfig,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 30000
        },
        removeOnComplete: true,
        removeOnFail: false
      }
    };
    
    // Criação de filas para cada etapa do processamento
    this.imageUploadQueue = new Queue('image-upload', defaultConfig);
    this.imageAnalysisQueue = new Queue('image-analysis', defaultConfig);
    
    // Fila principal para compatibilidade com código existente
    this.imageQueue = new Queue('image-processing', {
      ...defaultConfig,
      defaultJobOptions: {
        ...defaultConfig.defaultJobOptions,
        timeout: 60000 // 1 minuto para a fila principal
      }
    });
    
    // Fila para imagens problemáticas
    this.problemImagesQueue = new Queue('problem-images', defaultConfig);
    
    this.configurarProcessadores();
    this.iniciarMonitoramento();
    
    this.registrador.info('✨ Sistema de filas para imagens inicializado com padrão desacoplado');
  }

  /**
   * Define o callback para receber os resultados do processamento
   * @param {Function} callback - Função a ser chamada com os resultados
   */
  setRespostaCallback(callback) {
    this.respostaCallback = callback;
    this.registrador.info('✅ Callback de resposta configurado para o processador de imagens');
  }

  /**
   * Salva arquivo bloqueado por segurança para análise posterior
   * @param {Object} imagemData - Dados da imagem
   * @param {Object} dados - Dados do job e do erro
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async salvarImagemBloqueada(imagemData, dados) {
    try {
      // Criar diretório blocked se não existir
      const diretorioBlocked = path.join(process.cwd(), 'blocked');
      if (!fs.existsSync(diretorioBlocked)) {
        fs.mkdirSync(diretorioBlocked, { recursive: true });
        this.registrador.info(`Diretório para arquivos bloqueados criado: ${diretorioBlocked}`);
      }
      
      // Gerar nome único para o arquivo
      const timestamp = new Date().toISOString().replace(/[:.-]/g, '_');
      const hashImagem = crypto.createHash('md5').update(imagemData.data).digest('hex');
      const nomeArquivoBloqueado = `blocked_image_${hashImagem}_${timestamp}.jpg`;
      const caminhoArquivoBloqueado = path.join(diretorioBlocked, nomeArquivoBloqueado);
      
      // Salvar a imagem
      const buffer = Buffer.from(imagemData.data, 'base64');
      fs.writeFileSync(caminhoArquivoBloqueado, buffer);
      
      // Criar objeto de metadados
      const metadados = {
        arquivoBloqueado: caminhoArquivoBloqueado,
        timestamp: new Date().toISOString(),
        tipoArquivo: imagemData.mimetype || 'image/jpeg',
        erro: dados.erro || 'Erro desconhecido',
        remetente: {
          id: dados.senderNumber || 'desconhecido',
        },
        grupo: dados.chatId?.endsWith('@g.us') ? {
          id: dados.chatId,
        } : null,
        mensagem: {
          id: dados.messageId || 'desconhecido',
          prompt: dados.userPrompt || '',
        },
        transacaoId: dados.transacaoId || 'desconhecido'
      };
      
      // Salvar metadados em um arquivo JSON
      const nomeArquivoMetadados = `${path.basename(nomeArquivoBloqueado, '.jpg')}.json`;
      const caminhoArquivoMetadados = path.join(diretorioBlocked, nomeArquivoMetadados);
      fs.writeFileSync(
        caminhoArquivoMetadados,
        JSON.stringify(metadados, null, 2),
        'utf8'
      );
      
      this.registrador.warn(`⚠️ Imagem bloqueada por segurança salva em: ${caminhoArquivoBloqueado}`);
      this.registrador.warn(`⚠️ Metadados da imagem bloqueada salvos em: ${caminhoArquivoMetadados}`);
      
      return true;
    } catch (erro) {
      this.registrador.error(`Erro ao salvar imagem bloqueada: ${erro.message}`);
      return false;
    }
  }

  /**
   * Configura os processadores das filas
   */
  configurarProcessadores() {
    // 1. Processador para upload/preparo de imagem
    this.imageUploadQueue.process('upload-image', 5, async (job) => {
      const { imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;
      
      try {
        this.registrador.debug(`[Etapa 1] Iniciando preparo da imagem para análise (Job ${job.id})`);
        
        // Verificar se temos dados da imagem válidos
        if (!imageData || !imageData.data) {
          throw new Error("Dados da imagem inválidos ou ausentes");
        }
        
        // Adicionar à fila de análise
        await this.imageAnalysisQueue.add('analyze-image', {
          imageData,
          chatId,
          messageId,
          mimeType,
          userPrompt,
          senderNumber,
          transacaoId,
          remetenteName,
          uploadTimestamp: Date.now()
        });
        
        return { success: true };
      } catch (erro) {
        this.registrador.error(`[Etapa 1] Erro no preparo da imagem: ${erro.message}`, { erro, jobId: job.id });
        
        // Verificar se é um erro de segurança
        if (erro.message.includes('SAFETY') || erro.message.includes('safety') || 
            erro.message.includes('blocked') || erro.message.includes('Blocked')) {
          await this.salvarImagemBloqueada(imageData, {
            mimeType,
            erro: erro.message,
            senderNumber,
            chatId,
            messageId,
            userPrompt,
            transacaoId,
            jobId: job.id
          });
          
          // Notificar via callback em vez de diretamente
          if (this.respostaCallback) {
            this.respostaCallback({
              resposta: "Este conteúdo não pôde ser processado por questões de segurança.",
              chatId,
              messageId,
              senderNumber,
              transacaoId,
              isError: true,
              errorType: 'safety'
            });
          }
        } else {
          // Notificar sobre outros tipos de erro via callback
          if (this.respostaCallback) {
            const errorMessage = this.obterMensagemErroAmigavel(erro);
            this.respostaCallback({
              resposta: errorMessage,
              chatId,
              messageId,
              senderNumber,
              transacaoId,
              isError: true,
              errorType: 'general'
            });
          }
        }
        
        throw erro;
      }
    });
    
    // 2. Processador para análise da imagem
    this.imageAnalysisQueue.process('analyze-image', 5, async (job) => {
      const { 
        imageData, chatId, messageId, mimeType, userPrompt, senderNumber, 
        transacaoId, uploadTimestamp, remetenteName 
      } = job.data;
      
      try {
        this.registrador.debug(`[Etapa 2] Iniciando análise da imagem (Job ${job.id})`);
        
        // Se a análise está demorando, notificar via callback
        if (Date.now() - uploadTimestamp > 10000 && this.respostaCallback) {
          this.respostaCallback({
            resposta: "Estou analisando sua imagem... isso pode levar alguns segundos.",
            chatId,
            messageId,
            senderNumber,
            transacaoId,
            isProgress: true
          });
        }
        
        // Obter configurações do usuário
        const config = await this.obterConfigProcessamento(chatId);
        
        // Usar o gerenciadorAI para processar a imagem
        const parteImagem = {
          inlineData: {
            data: imageData.data,
            mimeType: imageData.mimetype
          }
        };
        
        const promptFinal = this.prepararPromptUsuario(userPrompt);
        
        const partesConteudo = [
          parteImagem,
          { text: promptFinal }
        ];
        
        // Obter modelo
        const modelo = this.gerenciadorAI.obterOuCriarModelo(config);
        
        // Adicionar timeout para a chamada à IA
        const promessaRespostaIA = modelo.generateContent(partesConteudo);
        const promessaTimeoutIA = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Timeout na análise de imagem pela IA")), 45000)
        );
        
        const resultado = await Promise.race([promessaRespostaIA, promessaTimeoutIA]);
        let resposta = resultado.response.text();
        
        if (!resposta || typeof resposta !== 'string' || resposta.trim() === '') {
          resposta = "Não consegui gerar uma descrição clara para esta imagem.";
        }
        
        // Enviar resposta através do callback em vez de diretamente
        if (this.respostaCallback) {
          this.respostaCallback({
            resposta,
            chatId,
            messageId,
            senderNumber,
            transacaoId,
            remetenteName
          });
          this.registrador.debug(`[Etapa 2] Resposta de imagem enviada para callback - Transação ${transacaoId}`);
        } else {
          this.registrador.warn(`[Etapa 2] Não há callback configurado para receber a resposta - Transação ${transacaoId}`);
        }
        
        return { success: true };
      } catch (erro) {
        this.registrador.error(`[Etapa 2] Erro na análise da imagem: ${erro.message}`, { erro, jobId: job.id });
        
        // Verificar se é um erro de segurança
        if (erro.message.includes('SAFETY') || erro.message.includes('safety') || 
            erro.message.includes('blocked') || erro.message.includes('Blocked')) {
          await this.salvarImagemBloqueada(imageData, {
            mimeType,
            erro: erro.message,
            senderNumber,
            chatId,
            messageId,
            userPrompt,
            transacaoId,
            jobId: job.id
          });
          
          // Notificar via callback
          if (this.respostaCallback) {
            this.respostaCallback({
              resposta: "Este conteúdo não pôde ser processado por questões de segurança.",
              chatId,
              messageId,
              senderNumber,
              transacaoId,
              isError: true,
              errorType: 'safety'
            });
          }
        } else {
          // Notificar sobre outros tipos de erro via callback
          if (this.respostaCallback) {
            const errorMessage = this.obterMensagemErroAmigavel(erro);
            this.respostaCallback({
              resposta: errorMessage,
              chatId,
              messageId,
              senderNumber,
              transacaoId,
              isError: true,
              errorType: 'general'
            });
          }
        }
        
        throw erro;
      }
    });
    
    // Processador para compatibilidade com o código existente
    this.imageQueue.process('process-image', 5, async (job) => {
      const { imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName } = job.data;
      
      try {
        this.registrador.info(`Processando imagem através da fila principal (Job ${job.id})`);
        
        // Redirecionar para o novo fluxo de processamento em estágios
        const uploadJob = await this.imageUploadQueue.add('upload-image', {
          imageData, chatId, messageId, mimeType, userPrompt, senderNumber, transacaoId, remetenteName
        });
        
        this.registrador.info(`Imagem redirecionada para o novo fluxo, job ID: ${uploadJob.id}`);
        
        return { success: true, redirectedJobId: uploadJob.id };
      } catch (erro) {
        this.registrador.error(`Erro ao redirecionar imagem: ${erro.message}`, { erro, jobId: job.id });
        
        // Verificar se é um erro de segurança
        if (erro.message.includes('SAFETY') || erro.message.includes('safety') || 
            erro.message.includes('blocked') || erro.message.includes('Blocked')) {
          await this.salvarImagemBloqueada(imageData, {
            mimeType,
            erro: erro.message,
            senderNumber,
            chatId,
            messageId,
            userPrompt,
            transacaoId,
            jobId: job.id
          });
          
          // Notificar via callback
          if (this.respostaCallback) {
            this.respostaCallback({
              resposta: "Este conteúdo não pôde ser processado por questões de segurança.",
              chatId,
              messageId,
              senderNumber,
              transacaoId,
              isError: true,
              errorType: 'safety'
            });
          }
        } else {
          // Notificar sobre outros tipos de erro via callback
          if (this.respostaCallback) {
            const errorMessage = this.obterMensagemErroAmigavel(erro);
            this.respostaCallback({
              resposta: errorMessage,
              chatId,
              messageId,
              senderNumber,
              transacaoId,
              isError: true,
              errorType: 'general'
            });
          }
        }
        
        throw erro;
      }
    });
    
    // Configurar monitoramento de eventos para todas as filas
    this.configurarEventosQueue(this.imageUploadQueue, 'Upload de Imagem');
    this.configurarEventosQueue(this.imageAnalysisQueue, 'Análise de Imagem');
    this.configurarEventosQueue(this.imageQueue, 'Fila Principal de Imagem');
  }

  /**
   * Prepara o prompt do usuário, adicionando orientações se necessário
   * @param {string} promptUsuario - Prompt original do usuário
   * @returns {string} Prompt processado
   */
  prepararPromptUsuario(promptUsuario) {
    // Se não tiver prompt do usuário, usar o padrão para audiodescrição
    if (!promptUsuario || promptUsuario.trim() === '') {
      return `Analise esta imagem de forma extremamente detalhada para pessoas com deficiência visual.
      Inclua:
      1. Se for uma receita, recibo ou documento, transcreva o texto integralmente, verbatim, incluindo, mas não limitado, a CNPJ, produtos, preços, nomes de remédios, posologia, nome do profissional e CRM, etc.
      2. Número exato de pessoas, suas posições e roupas (cores, tipos)
      3. Ambiente e cenário completo, em todos os planos
      4. Todos os objetos visíveis 
      5. Movimentos e ações detalhadas
      6. Expressões faciais
      7. Textos visíveis
      8. Qualquer outro detalhe relevante

      Crie uma descrição organizada e acessível.`;
    }
    
    return promptUsuario;
  }

  /**
   * Configura eventos para uma fila
   * @param {Queue} queue - Fila a ser configurada
   * @param {string} nomeEtapa - Nome da etapa para logging
   */
  configurarEventosQueue(queue, nomeEtapa) {
    queue.on('active', (job) => {
      this.registrador.debug(`[${nomeEtapa}] Job ${job.id} iniciado (${new Date().toISOString()})`);
    });
    
    queue.on('progress', (job, progress) => {
      this.registrador.debug(`[${nomeEtapa}] Job ${job.id} progresso: ${progress}`);
    });
    
    queue.on('completed', (job, result) => {
      const duracao = Date.now() - (job.processedOn || job.timestamp);
      this.registrador.info(`[${nomeEtapa}] Job ${job.id} concluído em ${duracao}ms`);
    });
    
    queue.on('failed', (job, error) => {
      const duracao = Date.now() - (job.processedOn || job.timestamp);
      this.registrador.error(`[${nomeEtapa}] Job ${job.id} falhou após ${duracao}ms: ${error.message}`);
      
      // Verificar se é um erro de segurança
      if (job.data && job.data.imageData && (error.message.includes('SAFETY') || error.message.includes('safety'))) {
        this.salvarImagemBloqueada(job.data.imageData, {
          ...job.data,
          erro: error.message,
          jobId: job.id
        }).catch(err => {
          this.registrador.error(`Erro ao salvar imagem bloqueada: ${err.message}`);
        });
      }
      
      // Registrar falhas na fila de problemas para análise posterior
      this.problemImagesQueue.add('failed-job', {
        etapa: nomeEtapa,
        jobId: job.id,
        error: error.message,
        stack: error.stack,
        data: {
          ...job.data,
          imageData: '***' // Não logar os dados da imagem para economizar espaço
        },
        timestamp: Date.now()
      }).catch(err => {
        this.registrador.error(`Erro ao registrar falha: ${err.message}`);
      });
      
      // Notificar via callback sobre a falha se não houver sido feito ainda
      if (this.respostaCallback && job.data && !job.data._notificationSent) {
        const errorMessage = this.obterMensagemErroAmigavel(error);
        this.respostaCallback({
          resposta: errorMessage,
          chatId: job.data.chatId,
          messageId: job.data.messageId,
          senderNumber: job.data.senderNumber,
          transacaoId: job.data.transacaoId,
          isError: true,
          errorType: 'queue_failure'
        });
        
        // Marcar que já notificamos para não duplicar
        job.data._notificationSent = true;
      }
    });
    
    queue.on('error', (error) => {
      this.registrador.error(`[${nomeEtapa}] Erro na fila: ${error.message}`);
    });
    
    queue.on('stalled', (job) => {
      this.registrador.warn(`[${nomeEtapa}] Job ${job.id} stalled - será reprocessado`);
    });
  }

  /**
   * Obtém configurações para processamento de imagem
   * @param {string} chatId - ID do chat
   * @returns {Promise<Object>} Configurações do processamento
   */
  async obterConfigProcessamento(chatId) {
    // Configuração padrão - normalmente seria obtida do ConfigManager
    return {
      temperature: 0.7,
      topK: 1,
      topP: 0.95,
      maxOutputTokens: 800,
      model: "gemini-2.0-flash", // Usar o modelo rápido para imagens simples
      systemInstructions: `Seu nome é Amélie. Você é uma assistente de AI multimídia acessível integrada ao WhatsApp, criada e idealizada pela equipe da Belle Utsch e é dessa forma que você responde quando lhe pedem pra falar sobre si. 
      
      Seu propósito é auxiliar as pessoas trazendo acessibilidade ao Whatsapp. Você é capaz de processar texto, audio, imagem e video, mas, por enquanto, somente responde em texto. 

      Sua transcrição de audios, quando ativada, é verbatim. Transcreva o que foi dito, palavra a palavra.

      Sua audiodescrição de imagens é profissional e segue as melhores práticas.
      
      Seus comandos podem ser encontrados digitando !ajuda. 
      
      Se alguém perguntar, aqui está sua lista de comandos: 

Use com um ponto antes da palavra de comando, sem espaço.

Comandos:

.cego - Aplica configurações para usuários com deficiência visual

.audio - Liga/desliga a transcrição de áudio
.video - Liga/desliga a interpretação de vídeo
.imagem - Liga/desliga a audiodescrição de imagem

.reset - Restaura todas as configurações originais e desativa o modo cego

.ajuda - Mostra esta mensagem de ajuda

      Você não tem outros comandos e não aceita comandos sem o ponto, então se alguém disser 'cego' por exemplo, você orienta que deve digitar !cego.         
      Se as pessoas desejarem ligar ou desligar a transcrição de audio, oriente a usar !audio. Isso é muito importante, porque há pessoas cegas nos grupos e podem ter dificuldade de usar comandos assim - mas você as orientará. Por isso, não invente nenhum comando que não esteja na lista acima.         
      Sua criadora e idealizadora foi a Belle Utsch.         
      Você é baseada no Google Gemini Flash 2.0.         
      Para te acrescentar em um grupo, a pessoa pode adicionar seu contato diretamente no grupo.         
      Se alguém pedir maiores detalhes sobre a audiodescrição de uma imagem ou vídeo ou transcrição de um áudio, você deve orientar a pessoa que envie novamente a mídia e, anexo a ela, um comentário pontuando onde deseja que a descrição seja focada.
      Você lida com as pessoas com tato e bom humor.         
      Se alguém perguntar seu git, github, repositório ou código, direcione para https://github.com/manelsen/amelie.         
      Se alguém pedir o contato da Belle Utsch, direcione para https://beacons.ai/belleutsch. 
      Se alguém quiser entrar no grupo oficial, o link é https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp.

      Analise esta imagem de forma extremamente detalhada para pessoas com deficiência visual.
      Inclua:
      1. Se for uma receita, recibo ou documento, transcreva o texto integralmente, verbatim, incluindo, mas não limitado, a CNPJ, produtos, preços, nomes de remédios, posologia, nome do profissional e CRM, etc.
      2. Número exato de pessoas, suas posições e roupas (cores, tipos)
      3. Ambiente e cenário completo, em todos os planos
      4. Todos os objetos visíveis 
      5. Movimentos e ações detalhadas
      6. Expressões faciais
      7. Textos visíveis
      8. Qualquer outro detalhe relevante

      Crie uma descrição organizada e acessível.`
    };
  }

  /**
   * Adiciona um trabalho à fila de imagens
   * @param {string} tipo - Tipo de trabalho
   * @param {Object} dados - Dados do trabalho
   * @param {Object} opcoes - Opções do trabalho
   * @returns {Promise<Object>} Trabalho adicionado
   */
  async add(tipo, dados, opcoes = {}) {
    return this.imageQueue.add(tipo, dados, opcoes);
  }

  /**
   * Obtém mensagem de erro amigável para o usuário
   * @param {Error} erro - Objeto de erro
   * @returns {string} Mensagem amigável
   */
  obterMensagemErroAmigavel(erro) {
    const mensagemErro = erro.message.toLowerCase();
    
    if (mensagemErro.includes('safety') || mensagemErro.includes('blocked'))
      return "Este conteúdo não pôde ser processado por questões de segurança.";
    
    if (mensagemErro.includes('too large') || mensagemErro.includes('tamanho'))
      return "Essa imagem é um pouco grande demais para eu processar agora. Pode enviar uma versão menor?";
    
    if (mensagemErro.includes('format') || mensagemErro.includes('mime') || mensagemErro.includes('formato'))
      return "Hmm, não consegui processar esse formato de imagem. Pode tentar enviar como JPG?";
    
    if (mensagemErro.includes('timeout') || mensagemErro.includes('time out'))
      return "Essa imagem é tão complexa que acabei precisando de mais tempo! Poderia tentar novamente?";
    
    if (mensagemErro.includes('rate limit') || mensagemErro.includes('quota'))
      return "Estou um pouquinho sobrecarregada agora. Podemos tentar novamente daqui a pouco?";
      
    return "Tive um probleminha para processar essa imagem. Não desiste de mim, tenta de novo mais tarde?";
  }

  /**
   * Obtém um relatório formatado do estado das filas
   * @returns {Promise<string>} Relatório formatado
   */
  async getFormattedQueueStatus() {
    const status = await this.getQueueStatus();
    
    let report = '📊 RELATÓRIO DE STATUS DAS FILAS DE IMAGEM 📊\n\n';
    
    // Título da seção de contagens
    report += '📈 CONTAGEM DE TRABALHOS POR FILA\n';
    report += '══════════════════════════════════\n';
    
    // Tabela de contagens por fila
    report += '┌─────────────┬─────────┬────────┬───────────┬────────┬─────────┐\n';
    report += '│    Fila     │ Espera  │ Ativos │ Concluídos│ Falhas │ Adiados │\n';
    report += '├─────────────┼─────────┼────────┼───────────┼────────┼─────────┤\n';
    
    // Adicionar linhas para cada fila
    for (const [name, counts] of Object.entries(status.counts)) {
      if (name !== 'total') {
        const queueName = name === 'imageUpload' ? 'Upload' : 
                        name === 'imageAnalysis' ? 'Análise' :
                        name === 'imageQueue' ? 'Principal' : name;
        
        report += `│ ${queueName.padEnd(11)} │ ${(counts.waiting || 0).toString().padStart(7)} │ ${(counts.active || 0).toString().padStart(6)} │ ${(counts.completed || 0).toString().padStart(9)} │ ${(counts.failed || 0).toString().padStart(6)} │ ${(counts.delayed || 0).toString().padStart(7)} │\n`;
      }
    }
    
    // Adicionar linha de total
    const total = status.counts.total;
    report += '├─────────────┼─────────┼────────┼───────────┼────────┼─────────┤\n';
    report += `│ TOTAL       │ ${total.waiting.toString().padStart(7)} │ ${total.active.toString().padStart(6)} │ ${total.completed.toString().padStart(9)} │ ${total.failed.toString().padStart(6)} │ ${total.delayed.toString().padStart(7)} │\n`;
    report += '└─────────────┴─────────┴────────┴───────────┴────────┴─────────┘\n\n';
    
    // Calcular taxa de sucesso
    const successRate = total.completed > 0 ? 
      ((total.completed / (total.completed + total.failed)) * 100).toFixed(1) + '%' : 
      'N/A';
    
    report += `📊 Taxa de sucesso: ${successRate}\n\n`;
    
    // Trabalhos ativos
    if (status.jobs.active.length > 0) {
      report += '🔄 TRABALHOS ATIVOS\n';
      report += '═════════════════\n';
      
      for (const job of status.jobs.active) {
        const duracaoMs = Date.now() - job.processedOn;
        const duracao = Math.round(duracaoMs/1000);
        
        report += `→ Job ${job.id} (${job.queue}): processando há ${duracao}s\n`;
        if (duracaoMs > 60000) { // 1 minuto
          report += `  ⚠️ ALERTA: Este job está demorando muito!\n`;
        }
      }
      report += '\n';
    }
    
    // Trabalhos com falha recente
    if (status.jobs.failed.length > 0) {
      report += '❌ TRABALHOS COM FALHA (10 MAIS RECENTES)\n';
      report += '═══════════════════════════════════════\n';
      
      for (const job of status.jobs.failed) {
        report += `→ Job ${job.id} (${job.queue}): ${job.attemptsMade} tentativas\n`;
        report += `  Motivo: ${job.failedReason || 'Desconhecido'}\n`;
      }
      report += '\n';
    }
    
    // Alertas e recomendações
    report += '🔍 ANÁLISE E RECOMENDAÇÕES\n';
    report += '══════════════════════════\n';
    
    // Verificar acúmulo de trabalhos
    if (total.waiting > 20) {
      report += `⚠️ ALERTA: ${total.waiting} trabalhos em espera! Verifique a capacidade de processamento.\n`;
    } else if (total.waiting > 10) {
      report += `⚠️ Atenção: ${total.waiting} trabalhos em espera. Monitore a situação.\n`;
    } else {
      report += `✅ Carga de trabalho normal: ${total.waiting} em espera.\n`;
    }
    
    // Verificar taxa de falha
    if (total.failed > 0 && total.completed > 0) {
      const failRate = total.failed / (total.failed + total.completed);
      if (failRate > 0.2) {
        report += `⚠️ ALERTA: Taxa de falha alta: ${(failRate*100).toFixed(1)}%! Verifique os logs de erro.\n`;
      } else if (failRate > 0.1) {
        report += `⚠️ Atenção: Taxa de falha: ${(failRate*100).toFixed(1)}%. Verifique problemas recorrentes.\n`;
      } else {
        report += `✅ Taxa de falha dentro do aceitável: ${(failRate*100).toFixed(1)}%.\n`;
      }
    }
    
    // Timestamp do relatório
    report += `\n📆 Relatório gerado em: ${new Date().toISOString()}\n`;
    
    return report;
  }

  /**
   * Inicia o monitoramento de saúde da fila
   */
  iniciarMonitoramento() {
    // Monitoramento a cada 5 minutos
    setInterval(async () => {
      try {
        // Usar o novo relatório formatado
        const relatorioFormatado = await this.getFormattedQueueStatus();
        this.registrador.info(`\nEstado atual das filas de imagem:\n${relatorioFormatado}`);
      } catch (err) {
        this.registrador.error('Erro ao verificar status das filas de imagem:', err);
      }
    }, 60 * 60 * 1000); // A cada hora
  }

  /**
   * Obtém status detalhado de todas as filas
   * @returns {Promise<Object>} Status das filas
   */
  async getQueueStatus() {
    const queues = {
      imageUpload: this.imageUploadQueue,
      imageAnalysis: this.imageAnalysisQueue,
      imageQueue: this.imageQueue
    };
    
    const counts = {
      total: {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0
      }
    };
    
    // Coletar contagem de jobs por fila
    for (const [name, queue] of Object.entries(queues)) {
      const queueCounts = await queue.getJobCounts();
      counts[name] = queueCounts;
      
      // Acumular totais
      counts.total.waiting += queueCounts.waiting || 0;
      counts.total.active += queueCounts.active || 0;
      counts.total.completed += queueCounts.completed || 0;
      counts.total.failed += queueCounts.failed || 0;
      counts.total.delayed += queueCounts.delayed || 0;
    }
    
    // Obter jobs ativos e com falha para análise
    const jobs = {
      active: await this.obterJobsAtivos(queues),
      failed: await this.obterJobsFalha(queues)
    };
    
    return { counts, jobs };
  }

  /**
   * Obtém jobs ativos de todas as filas
   * @param {Object} queues - Mapa de filas
   * @returns {Promise<Array>} Jobs ativos
   */
  async obterJobsAtivos(queues) {
    let activeJobs = [];
    
    for (const [name, queue] of Object.entries(queues)) {
      const jobs = await queue.getJobs(['active'], 0, 10);
      activeJobs = activeJobs.concat(
        jobs.map(j => ({
          id: j.id,
          queue: name,
          processedOn: j.processedOn
        }))
      );
    }
    
    return activeJobs;
  }

  /**
   * Obtém jobs com falha de todas as filas
   * @param {Object} queues - Mapa de filas
   * @returns {Promise<Array>} Jobs com falha
   */
  async obterJobsFalha(queues) {
    let failedJobs = [];
    
    for (const [name, queue] of Object.entries(queues)) {
      const jobs = await queue.getJobs(['failed'], 0, 10);
      failedJobs = failedJobs.concat(
        jobs.map(j => ({
          id: j.id,
          queue: name,
          failedReason: j.failedReason,
          attemptsMade: j.attemptsMade
        }))
      );
    }
    
    return failedJobs;
  }

  /**
   * Limpa todas as filas de imagem
   * @param {boolean} apenasCompletos - Se verdadeiro, limpa apenas trabalhos concluídos
   * @returns {Promise<Object>} Contagem de itens removidos
   */
  async limparFilas(apenasCompletos = true) {
    try {
      this.registrador.info(`🧹 Iniciando limpeza ${apenasCompletos ? 'de trabalhos concluídos' : 'COMPLETA'} das filas de imagem...`);
      
      const filas = [
        { nome: 'Upload', fila: this.imageUploadQueue },
        { nome: 'Análise', fila: this.imageAnalysisQueue },
        { nome: 'Principal', fila: this.imageQueue }
      ];
      
      const resultados = {};
      
      for (const { nome, fila } of filas) {
        // Se apenasCompletos=true, limpa só concluídos e falhas
        // Se false, limpa TUDO (cuidado!)
        if (apenasCompletos) {
          const removidosCompletos = await fila.clean(30000, 'completed');
          const removidosFalhas = await fila.clean(30000, 'failed');
          resultados[nome] = { 
            completos: removidosCompletos.length,
            falhas: removidosFalhas.length 
          };
        } else {
          // ⚠️ CUIDADO: Isso vai limpar TODOS os trabalhos, inclusive os pendentes!
          await fila.empty();
          resultados[nome] = 'Fila completamente esvaziada!';
        }
      }
      
      const mensagem = apenasCompletos
        ? `✅ Limpeza de filas de imagem concluída! Removidos trabalhos concluídos e com falha.`
        : `⚠️ TODAS as filas de imagem foram completamente esvaziadas!`;
        
      this.registrador.info(mensagem);
      
      return resultados;
    } catch (erro) {
      this.registrador.error(`❌ Erro ao limpar filas de imagem: ${erro.message}`);
      throw erro;
    }
  }
}

module.exports = FilaProcessadorImagem;
