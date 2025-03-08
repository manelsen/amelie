/**
 * MonitorSaude - Monitora a saúde do sistema
 * 
 * Este módulo centraliza monitoramento de conexão, memória, CPU 
 * e outros recursos para garantir um sistema estável.
 */

const fs = require('fs');

class MonitorSaude {
  /**
   * Cria uma instância do monitor de saúde
   * @param {Object} registrador - Objeto logger para registro de eventos
   * @param {Object} clienteWhatsApp - Instância do cliente WhatsApp
   * @param {Object} opcoes - Opções de configuração
   */
  constructor(registrador, clienteWhatsApp, opcoes = {}) {
    this.registrador = registrador;
    this.clienteWhatsApp = clienteWhatsApp;
    this.intervalos = {
      batimento: null,
      memoria: null,
      verificacaoConexao: null
    };
    
    this.configurarOpcoes(opcoes);
    this.ultimoBatimento = Date.now();
    this.inicioSistema = Date.now();
    this.contadorBatimentos = 0;
    this.falhasConsecutivas = 0;
    
    this.registrador.info('Monitor de saúde inicializado');
  }

  /**
   * Configura opções do monitor
   * @param {Object} opcoes - Opções de configuração
   */
  configurarOpcoes(opcoes) {
    this.opcoes = {
      intervaloBatimento: opcoes.intervaloBatimento || 20000, // 20 segundos
      intervaloMemoria: opcoes.intervaloMemoria || 300000, // 5 minutos
      intervaloVerificacaoConexao: opcoes.intervaloVerificacaoConexao || 60000, // 1 minuto
      limiteAlertaMemoria: opcoes.limiteAlertaMemoria || 1024, // 1GB
      limiteCriticoMemoria: opcoes.limiteCriticoMemoria || 1536, // 1.5GB
      limiteReconexoes: opcoes.limiteReconexoes || 5
    };
  }

  /**
   * Inicia todos os monitores
   */
  iniciar() {
    this.iniciarMonitorBatimento();
    this.iniciarMonitorMemoria();
    this.iniciarVerificacaoConexao();
    this.registrador.info('Monitores de saúde iniciados');
  }

  /**
   * Para todos os monitores
   */
  parar() {
    Object.values(this.intervalos).forEach(intervalo => {
      if (intervalo) clearInterval(intervalo);
    });
    
    this.intervalos = {
      batimento: null,
      memoria: null,
      verificacaoConexao: null
    };
    
    this.registrador.info('Monitores de saúde parados');
  }

  /**
   * Inicia o monitor de batimentos cardíacos
   */
  iniciarMonitorBatimento() {
    if (this.intervalos.batimento) {
      clearInterval(this.intervalos.batimento);
    }
    
    this.intervalos.batimento = setInterval(() => {
      this.emitirBatimento();
    }, this.opcoes.intervaloBatimento);
    
    // Primeiro batimento imediato
    this.emitirBatimento();
    this.registrador.info('Monitor de batimentos iniciado');
  }

  /**
   * Inicia o monitor de memória
   */
  iniciarMonitorMemoria() {
    if (this.intervalos.memoria) {
      clearInterval(this.intervalos.memoria);
    }
    
    this.intervalos.memoria = setInterval(() => {
      this.verificarMemoria();
    }, this.opcoes.intervaloMemoria);
    
    // Primeira verificação imediata
    this.verificarMemoria();
    this.registrador.info('Monitor de memória iniciado');
  }

  /**
   * Inicia a verificação periódica de conexão
   */
  iniciarVerificacaoConexao() {
    if (this.intervalos.verificacaoConexao) {
      clearInterval(this.intervalos.verificacaoConexao);
    }
    
    this.intervalos.verificacaoConexao = setInterval(() => {
      this.verificarConexao();
    }, this.opcoes.intervaloVerificacaoConexao);
    
    // Primeira verificação imediata
    this.verificarConexao();
    this.registrador.info('Verificação de conexão iniciada');
  }

/**
 * Verifica se o cliente do WhatsApp está realmente conectado
 * @returns {Promise<boolean>} Verdadeiro se o cliente estiver conectado
 */
async verificarConexaoAtiva() {
  try {
    // Verificação básica da existência do cliente
    if (!this.clienteWhatsApp || !this.clienteWhatsApp.cliente || !this.clienteWhatsApp.cliente.info) {
      return false;
    }
    
    // Se o cliente tem um ID (wid), isso já é um bom indicador
    const temId = Boolean(this.clienteWhatsApp.cliente.info.wid);
    
    // Verificação de capacidade de resposta via Puppeteer
    let estadoConexaoPuppeteer = false;
    
    // Verificar se temos um pupPage e se podemos acessá-lo
    if (this.clienteWhatsApp.cliente.pupPage) {
      try {
        // Verificar o estado de conexão interno
        estadoConexaoPuppeteer = await this.clienteWhatsApp.cliente.pupPage.evaluate(() => {
          // Verificação mais flexível - qualquer um destes é um bom sinal
          return Boolean(
            (window.Store && window.Store.Conn) || 
            (window.WAPI && window.WAPI.isConnected()) || 
            (window.WWebJS && window.WWebJS.isConnected) ||
            document.querySelector('[data-icon=":"]') !== null // Ícone de conexão online
          );
        }).catch(() => false);
      } catch (erroEval) {
        this.registrador.debug(`Erro na verificação do Puppeteer: ${erroEval.message}`);
      }
    }
    
    // Se alguma mensagem foi processada recentemente, consideramos como conectado
    const mensagemRecente = this.verificarMensagensRecentes();
    
    // Verificar se temos envios recentes bem-sucedidos (últimos 3 minutos)
    const envioRecente = (this.clienteWhatsApp.ultimoEnvio && 
                          (Date.now() - this.clienteWhatsApp.ultimoEnvio < 3 * 60 * 1000));
    
    // Novas métricas de saúde combinadas
    const sinaisPositivos = [
      temId,              // Tem identificação no WhatsApp
      estadoConexaoPuppeteer, // Puppeteer indica conectado
      mensagemRecente,    // Processou mensagens recentemente
      envioRecente        // Enviou mensagens recentemente
    ].filter(Boolean).length;
    
    // Se temos pelo menos 2 sinais positivos, consideramos conectado
    // Isso torna a detecção mais resistente a falsos negativos
    const estaConectado = sinaisPositivos >= 2;
    
    if (!estaConectado) {
      this.registrador.debug(`Diagnóstico de conexão: ID=${temId}, EstadoPuppeteer=${estadoConexaoPuppeteer}, MensagemRecente=${mensagemRecente}, EnvioRecente=${envioRecente}, SinaisPositivos=${sinaisPositivos}`);
    }
    
    return estaConectado;
  } catch (erro) {
    this.registrador.error(`Erro ao verificar estado da conexão: ${erro.message}`);
    return false;
  }
}
  /**
   * Verifica se houve mensagens processadas recentemente
   * @returns {boolean} Verdadeiro se mensagens foram processadas nos últimos minutos
   */
  verificarMensagensRecentes() {
    try {
      // Verificar os logs mais recentes em busca de atividade de mensagens
      const caminhoLog = './logs/bot.log';
      
      // Verificar se o arquivo existe
      if (!fs.existsSync(caminhoLog)) {
        this.registrador.debug(`Arquivo de log ${caminhoLog} não encontrado`);
        return false;
      }
      
      // Ler apenas as últimas linhas do arquivo para não sobrecarregar a memória
      let conteudoLog;
      try {
        // Ler apenas os últimos 50KB do arquivo
        const stats = fs.statSync(caminhoLog);
        const tamanhoLeitura = Math.min(stats.size, 50 * 1024); // 50KB máximo
        const buffer = Buffer.alloc(tamanhoLeitura);
        
        const fd = fs.openSync(caminhoLog, 'r');
        fs.readSync(fd, buffer, 0, tamanhoLeitura, stats.size - tamanhoLeitura);
        fs.closeSync(fd);
        
        conteudoLog = buffer.toString();
      } catch (erroLeitura) {
        this.registrador.error(`Erro ao ler arquivo de log: ${erroLeitura.message}`);
        return false;
      }
      
      const linhasRecentes = conteudoLog.split('\n').slice(-100); // Últimas 100 linhas
      
      // Data atual
      const agora = new Date();
      const doisMinutosAtras = new Date(agora.getTime() - 2 * 60 * 1000);
      
      // Padrões que indicam atividade real de mensagens
      const padroesAtividade = [
        'Mensagem de ',
        'Resposta:',
        'processando mídia'
      ];
      
      // Procurar nas linhas recentes por atividade dentro da janela de tempo
      for (const linha of linhasRecentes) {
        // Verificar se é uma linha de atividade
        if (!padroesAtividade.some(padrao => linha.includes(padrao))) continue;
        
        // Extrair timestamp
        const timestampMatch = linha.match(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
        if (!timestampMatch) continue;
        
        try {
          // Converter para data
          const dataLinha = new Date(timestampMatch[0]);
          
          // Se a linha é recente, consideramos como ativo
          if (dataLinha >= doisMinutosAtras) {
            return true;
          }
        } catch (erroData) {
          this.registrador.debug(`Erro ao processar data na linha: ${erroData.message}`);
          // Continuar para próxima linha
        }
      }
      
      return false;
    } catch (erro) {
      this.registrador.error(`Erro ao verificar mensagens recentes: ${erro.message}`);
      return false;
    }
  }

  /**
   * Registra um batimento cardíaco apenas se a conexão estiver ativa
   */
  async emitirBatimento() {
    const agora = Date.now();
    const intervaloReal = agora - this.ultimoBatimento;
    this.ultimoBatimento = agora;
    
    // Se houver atividade recente de mensagens, consideramos o sistema ativo
    // mesmo que o WhatsApp não pareça estar conectado pelos métodos tradicionais
    const temAtividadeRecente = this.verificarMensagensRecentes();
    
    // Verificar se a conexão com o WhatsApp está ativa
    const conexaoAtiva = await this.verificarConexaoAtiva();
    
    // Se a conexão não estiver ativa e não há atividade recente, registrar o problema e não emitir batimento
    if (!conexaoAtiva && !temAtividadeRecente) {
      this.registrador.warn('❌ Conexão WhatsApp inativa - batimento não emitido');
      return;
    }
    
    this.contadorBatimentos++;
    
    // A cada 10 batimentos, mostra estatísticas
    if (this.contadorBatimentos % 10 === 0) {
      const segundosAtivo = Math.floor((agora - this.inicioSistema) / 1000);
      this.registrador.info(`💓 Batimento #${this.contadorBatimentos} - Sistema ativo há ${segundosAtivo}s`);
    } else {
      this.registrador.info(`Batimento ${new Date().toISOString()} - Sistema ativo`);
    }
    
    // Verificar uso de memória ocasionalmente
    if (this.contadorBatimentos % 5 === 0) {
      this.verificarMemoria();
    }
  }

  /**
   * Verifica uso de memória e libera se necessário
   */
  verificarMemoria() {
    try {
      const usoMemoria = process.memoryUsage();
      const heapUsadoMB = Math.round(usoMemoria.heapUsed / 1024 / 1024);
      const rssMB = Math.round(usoMemoria.rss / 1024 / 1024);
      
      this.registrador.debug(`Memória: Heap ${heapUsadoMB}MB / RSS ${rssMB}MB`);
      
      // Se estiver usando muita memória (nível de alerta)
      if (heapUsadoMB > this.opcoes.limiteAlertaMemoria || rssMB > this.opcoes.limiteAlertaMemoria) {
        this.registrador.warn(`⚠️ Alto uso de memória detectado: Heap ${heapUsadoMB}MB / RSS ${rssMB}MB`);
        
        // Sugerir coleta de lixo se disponível
        if (global.gc) {
          this.registrador.info('Solicitando coleta de lixo...');
          global.gc();
        }
      }
      
      // Se estiver usando memória crítica
      if (heapUsadoMB > this.opcoes.limiteCriticoMemoria || rssMB > this.opcoes.limiteCriticoMemoria) {
        this.registrador.error(`⚠️ ALERTA CRÍTICO: Uso de memória excedeu limite crítico! RSS: ${rssMB}MB, Heap: ${heapUsadoMB}MB`);
        this.acaoMemoriaCritica();
      }
    } catch (erro) {
      this.registrador.error(`Erro ao verificar memória: ${erro.message}`);
    }
  }

  /**
   * Ação a ser tomada quando memória atingir nível crítico
   */
  acaoMemoriaCritica() {
    try {
      this.registrador.warn('Executando ações para reduzir uso de memória crítico');
      
      // Forçar coleta de lixo
      if (global.gc) {
        global.gc();
      }
      
      // Reiniciar cliente se necessário
      this.agendarReinicioCliente();
    } catch (erro) {
      this.registrador.error(`Erro na ação de memória crítica: ${erro.message}`);
    }
  }

  /**
   * Agenda um reinício do cliente em 10 segundos
   */
  agendarReinicioCliente() {
    this.registrador.warn('Agendando reinício do cliente devido a uso crítico de recursos');
    
    setTimeout(async () => {
      try {
        this.registrador.warn('Executando reinício agendado do cliente WhatsApp');
        await this.clienteWhatsApp.reiniciarCompleto();
      } catch (erro) {
        this.registrador.error(`Erro ao reiniciar cliente: ${erro.message}`);
      }
    }, 10000); // 10 segundos
  }

  /**
  * Verifica a conexão e tenta reconectar se necessário
  */
  async verificarConexao() {
    try {
      const conexaoAtiva = await this.verificarConexaoAtiva();
      const ultimoBatimentoAntigo = this.ultimoBatimento < Date.now() - (2 * 60 * 1000); // 2 minutos sem batimento
      
      if (!conexaoAtiva || ultimoBatimentoAntigo) {
        this.falhasConsecutivas++;
        let motivo = !conexaoAtiva ? 'Conexão inativa detectada' : 'Batimentos ausentes por mais de 2 minutos';
        this.registrador.warn(`${motivo} (falha ${this.falhasConsecutivas}/${this.opcoes.limiteReconexoes})`);
        
        // Estratégia de recuperação em camadas
        if (this.falhasConsecutivas === 1) {
          // Nível 1: Tentar reconexão simples
          this.registrador.warn(`Tentando reconexão leve...`);
          const reconectou = await this.clienteWhatsApp.reconectar();
          
          if (reconectou) {
            this.registrador.info(`Reconexão leve bem-sucedida!`);
            this.falhasConsecutivas = 0;
            this.ultimoBatimento = Date.now(); // Atualizar timestamp do batimento
            return;
          }
        } else if (this.falhasConsecutivas === 2) {
          // Nível 2: Tentar limpar recursos e reconectar
          this.registrador.warn(`Tentando reconexão com limpeza de recursos...`);
          
          // Sugerir coleta de lixo se disponível
          if (global.gc) {
            this.registrador.info('Solicitando coleta de lixo...');
            global.gc();
          }
          
          const reconectou = await this.clienteWhatsApp.reconectar();
          if (reconectou) {
            this.registrador.info(`Reconexão com limpeza bem-sucedida!`);
            this.falhasConsecutivas = 0;
            this.ultimoBatimento = Date.now();
            return;
          }
        } else if (this.falhasConsecutivas >= this.opcoes.limiteReconexoes) {
          // Nível 3: Reinício completo do cliente (não do processo)
          this.registrador.error(`Muitas falhas consecutivas. Iniciando reinício completo do cliente.`);
          
          try {
            // Reiniciar apenas o cliente WhatsApp, não o processo inteiro
            await this.clienteWhatsApp.reiniciarCompleto();
            
            // Atualizar timestamp para dar tempo ao sistema de se reestabelecer
            this.ultimoBatimento = Date.now();
            this.falhasConsecutivas = 0;
            
            this.registrador.info(`Reinício do cliente WhatsApp concluído com sucesso!`);
            return;
          } catch (erroReinicio) {
            this.registrador.error(`Falha no reinício do cliente: ${erroReinicio.message}`);
            
            // Aqui poderíamos implementar uma estratégia final, como sinalizar 
            // para um processo supervisor externo, mas sem matar o processo
          }
        } else {
          // Tentativas intermediárias
          this.registrador.warn(`Tentando reconexão padrão...`);
          const reconectou = await this.clienteWhatsApp.reconectar();
          
          if (reconectou) {
            this.registrador.info(`Reconexão padrão bem-sucedida!`);
            this.falhasConsecutivas = 0;
            this.ultimoBatimento = Date.now();
          }
        }
      } else {
        // Reset do contador de falhas se estiver tudo bem
        if (this.falhasConsecutivas > 0) {
          this.registrador.info(`Conexão normalizada após ${this.falhasConsecutivas} falhas`);
          this.falhasConsecutivas = 0;
        }
      }
    } catch (erro) {
      this.registrador.error(`Erro na verificação de conexão: ${erro.message}`);
    }
  }
  /**
 * Inicializa o monitor de saúde com watchdog interno
 */
iniciar() {
  this.iniciarMonitorBatimento();
  this.iniciarMonitorMemoria();
  this.iniciarVerificacaoConexao();
  this.iniciarWatchdogInterno(); // Nova função!
  this.registrador.info('Monitores de saúde iniciados');
}

/**
 * Inicia um watchdog interno que detecta paralisação total do sistema
 */
iniciarWatchdogInterno() {
  // Último momento em que o sistema fez qualquer operação
  this.ultimaAtividadeSistema = Date.now();
  
  // Criar arquivo de marcação de tempo
  fs.writeFileSync('./temp/ultimo_check.txt', Date.now().toString(), 'utf8');
  
  // Watchdog primário (dentro do processo)
  this.intervalos.watchdogInterno = setInterval(() => {
    // Atualizar marca de último check
    this.ultimaAtividadeSistema = Date.now();
    fs.writeFileSync('./temp/ultimo_check.txt', Date.now().toString(), 'utf8');
  }, 30000); // A cada 30 segundos
  
  // Watchdog secundário (verificação cruzada)
  this.intervalos.watchdogSecundario = setInterval(() => {
    try {
      // Ler a última marca de tempo
      const ultimoCheck = fs.readFileSync('./temp/ultimo_check.txt', 'utf8');
      const ultimoCheckTimestamp = parseInt(ultimoCheck);
      
      // Se o arquivo não foi atualizado há mais de 2 minutos, temos um travamento grave
      if (Date.now() - ultimoCheckTimestamp > 2 * 60 * 1000) {
        this.registrador.error(`⚠️ ALERTA CRÍTICO: Sistema paralisado detectado! Última atividade há ${Math.floor((Date.now() - ultimoCheckTimestamp)/1000)}s`);
        
        // Forçar reinício do cliente WhatsApp de forma agressiva
        this.recuperacaoEmergencia();
      }
    } catch (erro) {
      this.registrador.error(`Erro no watchdog secundário: ${erro.message}`);
    }
  }, 60000); // A cada 1 minuto
  
  this.registrador.info('Watchdog interno iniciado para detectar paralisação total');
}

/**
 * Procedimento de recuperação de emergência para casos críticos
 */
async recuperacaoEmergencia() {
  this.registrador.error('🚨 INICIANDO PROCEDIMENTO DE RECUPERAÇÃO DE EMERGÊNCIA 🚨');
  
  try {
    // 1. Forçar liberação de memória
    if (global.gc) {
      this.registrador.info('Forçando coleta de lixo...');
      global.gc();
    }
    
    // 2. Salvar estado crítico para análise posterior
    this.salvarEstadoCritico();
    
    // 3. Tentar matar e reiniciar o cliente diretamente
    if (this.clienteWhatsApp.cliente && this.clienteWhatsApp.cliente.pupBrowser) {
      try {
        await this.clienteWhatsApp.cliente.pupBrowser.close().catch(() => {});
      } catch (err) {
        this.registrador.error(`Não foi possível fechar o navegador: ${err.message}`);
      }
    }
    
    // 4. Reiniciar completamente o cliente
    this.registrador.info('Forçando reinício completo do cliente...');
    await this.clienteWhatsApp.reiniciarCompleto();
    
    // 5. Atualizar marcadores de tempo
    this.ultimoBatimento = Date.now();
    this.ultimaAtividadeSistema = Date.now();
    this.falhasConsecutivas = 0;
    
    this.registrador.info('✅ Recuperação de emergência concluída');
  } catch (erro) {
    this.registrador.error(`Falha na recuperação de emergência: ${erro.message}`);
    
    // Se tudo falhar, tentar uma última medida desesperada
    this.registrador.error('Tentando medida de último recurso...');
    
    // Reiniciar componentes críticos com novos objetos
    try {
      this.clienteWhatsApp.inicializarCliente();
      this.registrador.info('Cliente reinicializado de forma bruta');
    } catch (erroFinal) {
      this.registrador.error(`Falha na medida de último recurso: ${erroFinal.message}`);
    }
  }
}

/**
 * Salva informações sobre o estado crítico para diagnóstico
 */
salvarEstadoCritico() {
  try {
    const diretorioDiagnostico = './diagnosticos';
    if (!fs.existsSync(diretorioDiagnostico)) {
      fs.mkdirSync(diretorioDiagnostico, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const arquivoDiagnostico = path.join(diretorioDiagnostico, `travamento_${timestamp}.json`);
    
    // Coletar métricas do sistema
    const diagnostico = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memoria: process.memoryUsage(),
      ultimoBatimento: new Date(this.ultimoBatimento).toISOString(),
      ultimaAtividadeSistema: new Date(this.ultimaAtividadeSistema).toISOString(),
      contadorBatimentos: this.contadorBatimentos,
      falhasConsecutivas: this.falhasConsecutivas
    };
    
    fs.writeFileSync(arquivoDiagnostico, JSON.stringify(diagnostico, null, 2), 'utf8');
    this.registrador.info(`Informações de diagnóstico salvas em ${arquivoDiagnostico}`);
  } catch (erro) {
    this.registrador.error(`Erro ao salvar diagnóstico: ${erro.message}`);
  }
}

/**
 * Inicializa e configura a recuperação segura de transações
 */
async inicializarRecuperacaoSegura() {
  this.registrador.info('🚀 Iniciando procedimento de recuperação de transações...');
  
  // Indicador de sistema em inicialização para coordenar os componentes
  global.sistemaRecuperando = true;
  
  try {
    // Aguardar o cliente estar pronto
    if (!this.clienteWhatsApp.pronto) {
      this.registrador.info('⏳ Aguardando cliente WhatsApp estar pronto antes de recuperar transações...');
      await new Promise(resolve => {
        const verificador = setInterval(() => {
          if (this.clienteWhatsApp.pronto) {
            clearInterval(verificador);
            resolve();
          }
        }, 1000);
      });
    }
    
    // Um pouco mais de tempo para ter certeza que o cliente está estável
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Processar notificações pendentes
    const notificacoesProcessadas = await this.clienteWhatsApp.processarNotificacoesPendentes();
    
    // Permitir mais um tempinho de estabilização antes da recuperação completa
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Completar inicialização segura
    global.sistemaRecuperando = false;
    this.registrador.info(`✅ Recuperação segura concluída! ${notificacoesProcessadas} notificações recuperadas`);
    
    return notificacoesProcessadas;
  } catch (erro) {
    this.registrador.error(`❌ Erro na recuperação segura: ${erro.message}`);
    // Mesmo com erro, finalizar o modo de recuperação
    global.sistemaRecuperando = false;
    return 0;
  }
}

}

module.exports = MonitorSaude;