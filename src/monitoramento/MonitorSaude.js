/**
 * MonitorSaude - Monitora a saúde do sistema
 * 
 * Este módulo centraliza monitoramento de conexão, memória, CPU 
 * e outros recursos para garantir um sistema estável.
 * Implementado seguindo princípios funcionais com estado imutável.
 */

const fs = require('fs');
const path = require('path');

// ======= FUNÇÕES PURAS =======

/**
 * Cria configurações padrão mescladas com opções fornecidas
 * @param {Object} opcoes - Opções de configuração
 * @returns {Object} - Configurações mescladas
 */
const criarConfiguracoes = (opcoes = {}) => ({
  intervaloBatimento: opcoes.intervaloBatimento || 20000, // 20 segundos
  intervaloMemoria: opcoes.intervaloMemoria || 300000, // 5 minutos
  intervaloVerificacaoConexao: opcoes.intervaloVerificacaoConexao || 60000, // 1 minuto
  limiteAlertaMemoria: opcoes.limiteAlertaMemoria || 1024, // 1GB
  limiteCriticoMemoria: opcoes.limiteCriticoMemoria || 1536, // 1.5GB
  limiteReconexoes: opcoes.limiteReconexoes || 5
});

/**
 * Cria um estado inicial para o monitor
 * @param {Object} registrador - Objeto logger para registro de eventos
 * @param {Object} clienteWhatsApp - Instância do cliente WhatsApp
 * @param {Object} opcoes - Opções de configuração
 * @returns {Object} - Estado inicial do monitor
 */
const criarEstadoInicial = (registrador, clienteWhatsApp, opcoes = {}) => ({
  registrador,
  clienteWhatsApp,
  config: criarConfiguracoes(opcoes),
  contadores: {
    batimentos: 0,
    falhasConsecutivas: 0
  },
  timestamps: {
    ultimoBatimento: Date.now(),
    inicioSistema: Date.now(),
    ultimaAtividadeSistema: Date.now()
  },
  intervalos: {
    batimento: null,
    memoria: null,
    verificacaoConexao: null,
    watchdogInterno: null,
    watchdogSecundario: null
  }
});

/**
 * Formata o tempo em milissegundos para uma representação legível
 * @param {number} milissegundos - Tempo em milissegundos
 * @returns {string} Tempo formatado (ex: "2 dias, 5 horas, 3 minutos e 20 segundos")
 */
const formatarTempoAtivo = (milissegundos) => {
  // Calcular os componentes de tempo
  const segundosTotais = Math.floor(milissegundos / 1000);
  const dias = Math.floor(segundosTotais / (24 * 60 * 60));
  const horas = Math.floor((segundosTotais % (24 * 60 * 60)) / (60 * 60));
  const minutos = Math.floor((segundosTotais % (60 * 60)) / 60);
  const segundos = segundosTotais % 60;

  // Criar array de partes não-zero
  const partes = [];
  if (dias > 0) partes.push(`${dias} ${dias === 1 ? 'dia' : 'dias'}`);
  if (horas > 0) partes.push(`${horas} ${horas === 1 ? 'hora' : 'horas'}`);
  if (minutos > 0) partes.push(`${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`);
  if (segundos > 0 || partes.length === 0) partes.push(`${segundos} ${segundos === 1 ? 'segundo' : 'segundos'}`);

  // Formatar a saída final
  if (partes.length === 1) {
    return partes[0];
  } else if (partes.length === 2) {
    return partes.join(' e ');
  } else {
    const ultimaParte = partes.pop();
    return partes.join(', ') + ' e ' + ultimaParte;
  }
};

/**
 * Verifica se o Chrome do Puppeteer está vivo e respondendo
 * @param {Object} cliente - Cliente WhatsApp
 * @param {Object} registrador - Registrador para logs
 * @returns {Promise<boolean>} Verdadeiro se o Chrome estiver morto ou inacessível
 */
const verificarChromeVivo = async (cliente, registrador) => {
  try {
    // Verificar se o cliente WhatsApp tem o objeto de browser do Puppeteer
    if (!cliente || !cliente.pupBrowser) {
      return true; // Chrome não está disponível
    }

    // Tentar executar um comando simples no navegador para ver se ele responde
    const browser = cliente.pupBrowser;

    // Verificar se conseguimos obter as páginas abertas
    const pages = await Promise.race([
      browser.pages().catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 5000)) // Timeout de 5 segundos
    ]);

    // Se não conseguimos obter as páginas, o Chrome provavelmente está morto
    if (!pages) {
      registrador.warn('Não foi possível acessar as páginas do Chrome - possível crash');
      return true;
    }

    // Verificar se a página principal ainda existe e responde
    if (!cliente.pupPage) {
      registrador.warn('Página principal do WhatsApp não encontrada no Puppeteer');
      return true;
    }

    // Testar se conseguimos executar um JavaScript simples na página principal
    const podeExecutarJS = await Promise.race([
      cliente.pupPage.evaluate(() => true).catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(false), 5000)) // Timeout de 5 segundos
    ]);

    if (!podeExecutarJS) {
      registrador.warn('Não é possível executar JavaScript na página - Chrome provavelmente travado');
      return true;
    }

    // Verificar o processo do Chrome - se ele tem um PID válido
    if (browser.process() && browser.process().pid) {
      try {
        // No Node.js, podemos verificar se um processo existe enviando um sinal 0
        process.kill(browser.process().pid, 0);
        // Se chegou aqui, o processo existe
      } catch (e) {
        registrador.warn(`Processo do Chrome (PID ${browser.process().pid}) não está mais ativo`);
        return true;
      }
    }

    // Chrome parece estar funcionando normalmente
    return false;
  } catch (erro) {
    registrador.error(`Erro ao verificar estado do Chrome: ${erro.message}`);
    return true; // Em caso de erro, assumimos que o Chrome está com problemas
  }
};

/**
 * Verifica se há mensagens recentes nos logs
 * @param {Object} registrador - Objeto de logging
 * @returns {boolean} - Verdadeiro se mensagens foram processadas recentemente
 */
const verificarMensagensRecentes = (registrador) => {
  try {
    // Verificar os logs mais recentes em busca de atividade de mensagens
    const caminhoLog = './logs/bot.log';

    // Verificar se o arquivo existe
    if (!fs.existsSync(caminhoLog)) {
      registrador.debug(`Arquivo de log ${caminhoLog} não encontrado`);
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
      registrador.error(`Erro ao ler arquivo de log: ${erroLeitura.message}`);
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
        registrador.debug(`Erro ao processar data na linha: ${erroData.message}`);
        // Continuar para próxima linha
      }
    }

    return false;
  } catch (erro) {
    registrador.error(`Erro ao verificar mensagens recentes: ${erro.message}`);
    return false;
  }
};

/**
 * Verifica se o cliente WhatsApp está conectado
 * @param {Object} estado - Estado atual do monitor
 * @returns {Promise<Object>} - Resultado da verificação de conexão
 */
const verificarConexaoAtiva = async (estado) => {
  const { clienteWhatsApp, registrador } = estado;

  try {
    // Verificação básica da existência do cliente
    if (!clienteWhatsApp || !clienteWhatsApp.cliente || !clienteWhatsApp.cliente.info) {
      return { conectado: false, diagnostico: { motivo: "Cliente WhatsApp não inicializado" } };
    }

    // Verificação específica do estado do Chrome/Puppeteer
    const chromeMorto = await verificarChromeVivo(clienteWhatsApp.cliente, registrador);
    if (chromeMorto) {
      registrador.error('❌ Chrome do Puppeteer morreu ou está inacessível!');
      return {
        conectado: false,
        diagnostico: {
          motivo: "Chrome morto",
          requerReinicioImediato: true
        }
      };
    }

    // Se o cliente tem um ID (wid), isso já é um bom indicador
    const temId = Boolean(clienteWhatsApp.cliente.info.wid);

    // Verificação de capacidade de resposta via Puppeteer
    let estadoConexaoPuppeteer = false;

    // Verificar se temos um pupPage e se podemos acessá-lo
    if (clienteWhatsApp.cliente.pupPage) {
      try {
        // Verificar o estado de conexão interno
        estadoConexaoPuppeteer = await clienteWhatsApp.cliente.pupPage.evaluate(() => {
          // Verificação mais flexível - qualquer um destes é um bom sinal
          return Boolean(
            (window.Store && window.Store.Conn) ||
            (window.WAPI && window.WAPI.isConnected()) ||
            (window.WWebJS && window.WWebJS.isConnected) ||
            document.querySelector('[data-icon=":"]') !== null // Ícone de conexão online
          );
        }).catch(() => false);
      } catch (erroEval) {
        registrador.debug(`Erro na verificação do Puppeteer: ${erroEval.message}`);
      }
    }

    // Se alguma mensagem foi processada recentemente, consideramos como conectado
    const mensagemRecente = verificarMensagensRecentes(registrador);

    // Verificar se temos envios recentes bem-sucedidos (últimos 3 minutos)
    const envioRecente = (clienteWhatsApp.ultimoEnvio &&
      (Date.now() - clienteWhatsApp.ultimoEnvio < 3 * 60 * 1000));

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

    const diagnostico = {
      temId,
      estadoConexaoPuppeteer,
      mensagemRecente,
      envioRecente,
      sinaisPositivos
    };

    if (!estaConectado) {
      registrador.debug(`Diagnóstico de conexão: ID=${temId}, EstadoPuppeteer=${estadoConexaoPuppeteer}, MensagemRecente=${mensagemRecente}, EnvioRecente=${envioRecente}, SinaisPositivos=${sinaisPositivos}`);
    }

    return { conectado: estaConectado, diagnostico };
  } catch (erro) {
    registrador.error(`Erro ao verificar estado da conexão: ${erro.message}`);
    return { conectado: false, diagnostico: { erro: erro.message } };
  }
};

/**
 * Verifica o uso de memória do sistema
 * @param {Object} estado - Estado atual do monitor
 * @returns {Object} - Novo estado e resultado da verificação
 */
const verificarMemoria = (estado) => {
  const { registrador, config } = estado;

  try {
    const usoMemoria = process.memoryUsage();
    const heapUsadoMB = Math.round(usoMemoria.heapUsed / 1024 / 1024);
    const rssMB = Math.round(usoMemoria.rss / 1024 / 1024);

    registrador.debug(`Memória: Heap ${heapUsadoMB}MB / RSS ${rssMB}MB`);

    let resultado = { estado: 'normal' };

    // Se estiver usando muita memória (nível de alerta)
    if (heapUsadoMB > config.limiteAlertaMemoria || rssMB > config.limiteAlertaMemoria) {
      registrador.warn(`⚠️ Alto uso de memória detectado: Heap ${heapUsadoMB}MB / RSS ${rssMB}MB`);
      resultado = { ...resultado, estado: 'alerta' };

      // Sugerir coleta de lixo se disponível
      if (global.gc) {
        registrador.info('Solicitando coleta de lixo...');
        global.gc();
      }
    }

    // Se estiver usando memória crítica
    if (heapUsadoMB > config.limiteCriticoMemoria || rssMB > config.limiteCriticoMemoria) {
      registrador.error(`⚠️ ALERTA CRÍTICO: Uso de memória excedeu limite crítico! RSS: ${rssMB}MB, Heap: ${heapUsadoMB}MB`);
      resultado = { ...resultado, estado: 'critico' };
    }

    return {
      resultado,
      metricas: { heapUsadoMB, rssMB }
    };
  } catch (erro) {
    registrador.error(`Erro ao verificar memória: ${erro.message}`);
    return {
      resultado: { estado: 'erro', mensagem: erro.message },
      metricas: {}
    };
  }
};

/**
 * Executa um batimento cardíaco para monitorar a saúde do sistema
 * @param {Object} estado - Estado atual do monitor
 * @returns {Promise<Object>} - Novo estado com resultados do batimento
 */
const executarBatimento = async (estado) => {
  const { registrador, timestamps, contadores, clienteWhatsApp } = estado;

  try {
    const agora = Date.now();
    const intervaloReal = agora - timestamps.ultimoBatimento;

    // Se houver atividade recente de mensagens, consideramos o sistema ativo
    // mesmo que o WhatsApp não pareça estar conectado pelos métodos tradicionais
    const temAtividadeRecente = verificarMensagensRecentes(registrador);

    // Verificar se a conexão com o WhatsApp está ativa
    const { conectado: conexaoAtiva, diagnostico } = await verificarConexaoAtiva(estado);

    // Se a conexão não estiver ativa e não há atividade recente, registrar o problema e não emitir batimento
    if (!conexaoAtiva && !temAtividadeRecente) {
      registrador.warn('❌ Conexão WhatsApp inativa - batimento não emitido');

      // Verificar se é necessário reinício imediato (Chrome morto)
      if (diagnostico && diagnostico.requerReinicioImediato) {
        return {
          ...estado,
          acoes: [{ tipo: 'reinicioImediato', motivo: 'Chrome morto' }]
        };
      }

      return {
        ...estado,
        resultadoBatimento: { sucesso: false, motivo: 'Conexão inativa' }
      };
    }

    // Atualizar contadores
    const novoContadorBatimentos = contadores.batimentos + 1;

    // A cada 10 batimentos, mostra estatísticas
    if (novoContadorBatimentos % 10 === 0) {
      const tempoAtivo = formatarTempoAtivo(agora - timestamps.inicioSistema);
      registrador.info(`💜 #${novoContadorBatimentos} - Amélie ativa há ${tempoAtivo}`);
    } /* else {
      registrador.info(`💓 ${new Date().toISOString()} - Amélie ativa`);
    }*/

    // Verificar uso de memória ocasionalmente
    let resultadoMemoria = null;
    if (novoContadorBatimentos % 5 === 0) {
      resultadoMemoria = verificarMemoria(estado);
    }

    return {
      ...estado,
      contadores: {
        ...contadores,
        batimentos: novoContadorBatimentos
      },
      timestamps: {
        ...timestamps,
        ultimoBatimento: agora
      },
      resultadoBatimento: {
        sucesso: true,
        temAtividadeRecente,
        conexaoAtiva,
        diagnostico
      },
      resultadoMemoria
    };
  } catch (erro) {
    registrador.error(`Erro ao emitir batimento: ${erro.message}`);
    return {
      ...estado,
      resultadoBatimento: {
        sucesso: false,
        erro: erro.message
      }
    };
  }
};

/**
 * Gerencia a recuperação de emergência do sistema
 * @param {Object} estado - Estado atual do monitor
 * @returns {Promise<Object>} - Novo estado após ações de emergência
 */
const recuperacaoEmergencia = async (estado) => {
  const { registrador, clienteWhatsApp } = estado;

  registrador.error('🚨 Procedimento de Recuperação de Emergência 🚨');

  try {
    // 1. Forçar liberação de memória
    if (global.gc) {
      registrador.info('Forçando coleta de lixo...');
      global.gc();
    }

    // 2. Salvar estado crítico para análise posterior
    salvarEstadoCritico(estado);

    // 3. NOVO: Limpar arquivos de bloqueio do Chrome com verificações de segurança
    try {
      // Verificar se há outras instâncias ativas do Chrome antes de limpar
      const verificarChromeAtivo = () => {
        try {
          // No Linux/Mac, podemos usar o comando ps
          const resultado = require('child_process').execSync('ps aux | grep chrome | grep -v grep').toString();
          const linhas = resultado.split('\n').filter(Boolean);

          // Se encontrar mais de uma linha com chrome (além do nosso), pode ter outras instâncias
          if (linhas.length > 1) {
            registrador.warn('⚠️ Detectadas possíveis instâncias ativas de Chrome! Removendo bloqueios com cautela.');
            return true;
          }
          return false;
        } catch (e) {
          // Se o comando falhar, provavelmente não há chrome rodando
          return false;
        }
      };

      const diretorioPerfil = path.join(process.cwd(), '.wwebjs_auth/session-principal');

      // Verificar se existem outros browsers ativos
      const chromeAtivo = verificarChromeAtivo();
      if (chromeAtivo) {
        registrador.warn('🔍 Outras instâncias do Chrome podem estar ativas. Aguardando 5 segundos...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Tratar o arquivo principal de bloqueio
      const arquivoLock = path.join(diretorioPerfil, 'SingletonLock');
      if (fs.existsSync(arquivoLock)) {
        const stats = fs.statSync(arquivoLock);
        const idadeArquivoSegundos = (Date.now() - stats.mtimeMs) / 1000;

        // Só remover se o arquivo tiver mais de 30 segundos 
        if (idadeArquivoSegundos > 30) {
          registrador.info(`🔓 Removendo arquivo de bloqueio do Chrome (idade: ${Math.round(idadeArquivoSegundos)}s)...`);
          fs.unlinkSync(arquivoLock);
        } else {
          registrador.warn(`⚠️ Arquivo de bloqueio parece recente (${Math.round(idadeArquivoSegundos)}s). Não vou remover.`);
        }
      }

      // Verificar outros arquivos que podem causar problemas
      const outrosArquivosBloqueio = [
        'SingletonCookie',
        'SingletonSocket',
        'Singleton*'
      ];

      if (fs.existsSync(diretorioPerfil)) {
        const arquivos = fs.readdirSync(diretorioPerfil);
        for (const padrao of outrosArquivosBloqueio) {
          const padraoBase = padrao.replace('*', '');
          const arquivosParaRemover = arquivos.filter(arquivo => arquivo.includes(padraoBase));

          for (const arquivo of arquivosParaRemover) {
            try {
              const caminhoArquivo = path.join(diretorioPerfil, arquivo);
              const stats = fs.statSync(caminhoArquivo);
              const idadeArquivoSegundos = (Date.now() - stats.mtimeMs) / 1000;

              // Só remover se o arquivo tiver mais de 30 segundos
              if (idadeArquivoSegundos > 30) {
                fs.unlinkSync(caminhoArquivo);
                registrador.info(`🔓 Removido arquivo de bloqueio: ${arquivo} (idade: ${Math.round(idadeArquivoSegundos)}s)`);
              } else {
                registrador.warn(`⚠️ Arquivo ${arquivo} parece recente (${Math.round(idadeArquivoSegundos)}s). Não vou remover.`);
              }
            } catch (e) {
              registrador.debug(`Não foi possível remover ${arquivo}: ${e.message}`);
            }
          }
        }
      }
    } catch (erroLimpeza) {
      registrador.warn(`Erro ao limpar arquivos de bloqueio: ${erroLimpeza.message}`);
    }

    // 4. Tentar matar e reiniciar o cliente diretamente
    if (clienteWhatsApp.cliente && clienteWhatsApp.cliente.pupBrowser) {
      try {

        // JERÔNIMO! MATA O CHROME!

        require('child_process').execSync(`pm2 restart all`);
        await clienteWhatsApp.cliente.pupBrowser.close().catch(() => { });
      } catch (err) {
        registrador.error(`Não foi possível fechar o navegador: ${err.message}`);
      }
    }

    // 5. Aguardar um momento para garantir que todos os processos foram encerrados
    registrador.info('Aguardando 3 segundos para garantir que processos terminem...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 6. Reiniciar completamente o cliente
    registrador.info('Forçando reinício completo do cliente...');
    await clienteWhatsApp.reiniciarCompleto();

    registrador.info('✅ Recuperação de emergência concluída');

    return {
      ...estado,
      contadores: {
        ...estado.contadores,
        falhasConsecutivas: 0
      },
      timestamps: {
        ...timestamps,
        ultimoBatimento: Date.now(),
        ultimaAtividadeSistema: Date.now()
      },
      recuperacaoExecutada: true
    };
  } catch (erro) {
    registrador.error(`Falha na recuperação de emergência: ${erro.message}`);

    // Se tudo falhar, tentar uma última medida desesperada
    registrador.error('Tentando medida de último recurso...');

    // Tentar limpar recursos de forma mais agressiva
    try {
      // Aguardar mais um pouco antes das medidas extremas
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Limpar diretório de cache do Chrome como último recurso
      const diretorioCache = path.join(process.cwd(), '.wwebjs_auth/session-principal/Default/Cache');
      if (fs.existsSync(diretorioCache)) {
        registrador.info('🧹 Limpando cache do Chrome como medida extrema...');
        // Apenas limpar arquivos, não diretórios, para não corromper a estrutura
        const arquivos = fs.readdirSync(diretorioCache)
          .filter(item => {
            try {
              return fs.statSync(path.join(diretorioCache, item)).isFile();
            } catch (e) {
              return false;
            }
          });

        for (const arquivo of arquivos) {
          try {
            fs.unlinkSync(path.join(diretorioCache, arquivo));
          } catch (e) {
            // Ignorar erros de remoção individual
          }
        }
      }

      // Reiniciar componentes críticos com novos objetos
      clienteWhatsApp.inicializarCliente();
      registrador.info('Cliente reinicializado de forma bruta');

      return {
        ...estado,
        recuperacaoExecutada: true,
        recuperacaoComplexa: true
      };
    } catch (erroFinal) {
      registrador.error(`Falha na medida de último recurso: ${erroFinal.message}`);

      return {
        ...estado,
        recuperacaoExecutada: false,
        erroRecuperacao: erroFinal.message
      };
    }
  }
};

/**
 * Salva informações sobre o estado crítico para diagnóstico
 * @param {Object} estado - Estado atual do monitor
 */
const salvarEstadoCritico = (estado) => {
  const { registrador, timestamps, contadores } = estado;

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
      ultimoBatimento: new Date(timestamps.ultimoBatimento).toISOString(),
      ultimaAtividadeSistema: new Date(timestamps.ultimaAtividadeSistema).toISOString(),
      contadorBatimentos: contadores.batimentos,
      falhasConsecutivas: contadores.falhasConsecutivas
    };

    fs.writeFileSync(arquivoDiagnostico, JSON.stringify(diagnostico, null, 2), 'utf8');
    registrador.info(`Informações de diagnóstico salvas em ${arquivoDiagnostico}`);
  } catch (erro) {
    registrador.error(`Erro ao salvar diagnóstico: ${erro.message}`);
  }
};

/**
 * Verifica o estado da conexão e executa ações de recuperação se necessário
 * @param {Object} estado - Estado atual do monitor
 * @returns {Promise<Object>} - Novo estado após verificação e possíveis ações
 */
const gerenciarEstadoConexao = async (estado) => {
  const { registrador, clienteWhatsApp, timestamps, contadores, config } = estado;

  try {
    const { conectado: conexaoAtiva, diagnostico } = await verificarConexaoAtiva(estado);
    const ultimoBatimentoAntigo = timestamps.ultimoBatimento < Date.now() - (2 * 60 * 1000); // 2 minutos sem batimento

    // Chrome está morto - precisa de reinício imediato
    if (diagnostico && diagnostico.requerReinicioImediato) {
      registrador.warn('Chrome morto detectado - iniciando recuperação de emergência');
      return await recuperacaoEmergencia(estado);
    }

    if (!conexaoAtiva || ultimoBatimentoAntigo) {
      const novasFalhasConsecutivas = contadores.falhasConsecutivas + 1;
      let motivo = !conexaoAtiva ? 'Conexão inativa detectada' : 'Batimentos ausentes por mais de 2 minutos';
      registrador.warn(`${motivo} (falha ${novasFalhasConsecutivas}/${config.limiteReconexoes})`);

      let novoEstado = {
        ...estado,
        contadores: {
          ...contadores,
          falhasConsecutivas: novasFalhasConsecutivas
        }
      };

      // Estratégia de recuperação em camadas
      if (novasFalhasConsecutivas === 1) {
        // Nível 1: Tentar reconexão simples
        registrador.warn(`Tentando reconexão leve...`);
        const reconectou = await clienteWhatsApp.reconectar();

        if (reconectou) {
          registrador.info(`Reconexão leve bem-sucedida!`);
          return {
            ...novoEstado,
            contadores: {
              ...novoEstado.contadores,
              falhasConsecutivas: 0
            },
            timestamps: {
              ...novoEstado.timestamps,
              ultimoBatimento: Date.now()
            }
          };
        }
      } else if (novasFalhasConsecutivas === 2) {
        // Nível 2: Tentar limpar recursos e reconectar
        registrador.warn(`Tentando reconexão com limpeza de recursos...`);

        // Sugerir coleta de lixo se disponível
        if (global.gc) {
          registrador.info('Solicitando coleta de lixo...');
          global.gc();
        }

        const reconectou = await clienteWhatsApp.reconectar();
        if (reconectou) {
          registrador.info(`Reconexão com limpeza bem-sucedida!`);
          return {
            ...novoEstado,
            contadores: {
              ...novoEstado.contadores,
              falhasConsecutivas: 0
            },
            timestamps: {
              ...novoEstado.timestamps,
              ultimoBatimento: Date.now()
            }
          };
        }
      } else if (novasFalhasConsecutivas >= config.limiteReconexoes) {
        // Nível 3: Reinício completo do cliente (não do processo)
        registrador.error(`Muitas falhas consecutivas. Iniciando reinício completo do cliente.`);

        try {
          // Reiniciar apenas o cliente WhatsApp, não o processo inteiro
          await clienteWhatsApp.reiniciarCompleto();

          return {
            ...novoEstado,
            contadores: {
              ...novoEstado.contadores,
              falhasConsecutivas: 0
            },
            timestamps: {
              ...novoEstado.timestamps,
              ultimoBatimento: Date.now()
            }
          };
        } catch (erroReinicio) {
          registrador.error(`Falha no reinício do cliente: ${erroReinicio.message}`);
          return novoEstado;
        }
      } else {
        // Tentativas intermediárias
        registrador.warn(`Tentando reconexão padrão...`);
        const reconectou = await clienteWhatsApp.reconectar();

        if (reconectou) {
          registrador.info(`Reconexão padrão bem-sucedida!`);
          return {
            ...novoEstado,
            contadores: {
              ...novoEstado.contadores,
              falhasConsecutivas: 0
            },
            timestamps: {
              ...novoEstado.timestamps,
              ultimoBatimento: Date.now()
            }
          };
        }
      }

      return novoEstado;
    } else {
      // Reset do contador de falhas se estiver tudo bem
      if (contadores.falhasConsecutivas > 0) {
        registrador.info(`Conexão normalizada após ${contadores.falhasConsecutivas} falhas`);
        return {
          ...estado,
          contadores: {
            ...contadores,
            falhasConsecutivas: 0
          }
        };
      }
      return estado;
    }
  } catch (erro) {
    registrador.error(`Erro na verificação de conexão: ${erro.message}`);
    return estado;
  }
};

/**
 * Inicializa a recuperação segura de transações
 * @param {Object} estado - Estado atual do monitor
 * @returns {Promise<Object>} - Resultado da recuperação segura
 */
const inicializarRecuperacaoSegura = async (estado) => {
  const { registrador, clienteWhatsApp } = estado;

  registrador.info('🚀 Iniciando procedimento de recuperação de transações...');

  // Indicador de sistema em inicialização para coordenar os componentes
  global.sistemaRecuperando = true;

  try {
    // Aguardar o cliente estar pronto
    if (!clienteWhatsApp.pronto) {
      registrador.info('⏳ Aguardando cliente WhatsApp estar pronto antes de recuperar transações...');
      await new Promise(resolve => {
        const verificador = setInterval(() => {
          if (clienteWhatsApp.pronto) {
            clearInterval(verificador);
            resolve();
          }
        }, 1000);
      });
    }

    // Um pouco mais de tempo para ter certeza que o cliente está estável
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Processar notificações pendentes
    const notificacoesProcessadas = await clienteWhatsApp.processarNotificacoesPendentes();

    // Permitir mais um tempinho de estabilização antes da recuperação completa
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Completar inicialização segura
    global.sistemaRecuperando = false;
    registrador.info(`✅ Recuperação segura concluída! ${notificacoesProcessadas} notificações recuperadas`);

    return {
      resultado: true,
      notificacoesProcessadas
    };
  } catch (erro) {
    registrador.error(`❌ Erro na recuperação segura: ${erro.message}`);
    // Mesmo com erro, finalizar o modo de recuperação
    global.sistemaRecuperando = false;
    return {
      resultado: false,
      erro: erro.message
    };
  }
};

// ======= GERENCIADORES DE INTERVALOS =======

/**
 * Inicia todos os monitores
 * @param {Object} estado - Estado atual do monitor
 * @returns {Object} - Novo estado com intervalos ativos
 */
const iniciarMonitores = (estado) => {
  const { registrador } = estado;

  // Parar quaisquer intervalos existentes primeiro
  const novoEstado = pararMonitores(estado);

  // Criar novos intervalos e atualizar o estado
  const intervalos = {
    batimento: setInterval(() => {
      // Usamos uma IIFE assíncrona para poder usar await dentro do setInterval
      (async () => {
        try {
          monitor.estado = await executarBatimento(monitor.estado);

          // Verificar se há ações a serem tomadas
          if (monitor.estado.acoes && monitor.estado.acoes.length > 0) {
            for (const acao of monitor.estado.acoes) {
              if (acao.tipo === 'reinicioImediato') {
                monitor.estado = await recuperacaoEmergencia(monitor.estado);
              }
            }
            // Limpar ações processadas
            monitor.estado = { ...monitor.estado, acoes: [] };
          }
        } catch (erro) {
          registrador.error(`Erro no ciclo de batimento: ${erro.message}`);
        }
      })();
    }, novoEstado.config.intervaloBatimento),

    memoria: setInterval(() => {
      try {
        const resultado = verificarMemoria(monitor.estado);
        monitor.estado = {
          ...monitor.estado,
          resultadoMemoria: resultado
        };

        // Se memória crítica, agendar reinício
        if (resultado.resultado.estado === 'critico') {
          (async () => {
            monitor.estado = await recuperacaoEmergencia(monitor.estado);
          })();
        }
      } catch (erro) {
        registrador.error(`Erro no ciclo de verificação de memória: ${erro.message}`);
      }
    }, novoEstado.config.intervaloMemoria),

    verificacaoConexao: setInterval(() => {
      (async () => {
        try {
          monitor.estado = await gerenciarEstadoConexao(monitor.estado);
        } catch (erro) {
          registrador.error(`Erro no ciclo de verificação de conexão: ${erro.message}`);
        }
      })();
    }, novoEstado.config.intervaloVerificacaoConexao),

    watchdogInterno: setInterval(() => {
      try {
        // Atualizar marca de último check
        const novoTimestamp = Date.now();
        fs.writeFileSync('./temp/ultimo_check.txt', novoTimestamp.toString(), 'utf8');

        monitor.estado = {
          ...monitor.estado,
          timestamps: {
            ...monitor.estado.timestamps,
            ultimaAtividadeSistema: novoTimestamp
          }
        };
      } catch (erro) {
        registrador.error(`Erro no watchdog interno: ${erro.message}`);
      }
    }, 30000), // 30 segundos

    watchdogSecundario: setInterval(() => {
      try {
        // Ler a última marca de tempo
        const ultimoCheck = fs.readFileSync('./temp/ultimo_check.txt', 'utf8');
        const ultimoCheckTimestamp = parseInt(ultimoCheck);

        // Se o arquivo não foi atualizado há mais de 2 minutos, temos um travamento grave
        if (Date.now() - ultimoCheckTimestamp > 2 * 60 * 1000) {
          registrador.error(`⚠️ ALERTA CRÍTICO: Sistema paralisado detectado! Última atividade há ${Math.floor((Date.now() - ultimoCheckTimestamp) / 1000)}s`);

          // Forçar recuperação de emergência
          (async () => {
            monitor.estado = await recuperacaoEmergencia(monitor.estado);
          })();
        }
      } catch (erro) {
        registrador.error(`Erro no watchdog secundário: ${erro.message}`);
      }
    }, 60000) // 1 minuto
  };

  // Primeiro batimento imediato
  (async () => {
    try {
      monitor.estado = await executarBatimento(monitor.estado);
    } catch (erro) {
      registrador.error(`Erro no batimento inicial: ${erro.message}`);
    }
  })();

  // Criar diretório temp se não existir
  try {
    if (!fs.existsSync('./temp')) {
      fs.mkdirSync('./temp', { recursive: true });
    }
    fs.writeFileSync('./temp/ultimo_check.txt', Date.now().toString(), 'utf8');
  } catch (erro) {
    registrador.error(`Erro ao criar diretório temp: ${erro.message}`);
  }

  registrador.info('Monitores de saúde iniciados');

  return {
    ...novoEstado,
    intervalos
  };
};

/**
 * Para todos os monitores
 * @param {Object} estado - Estado atual do monitor
 * @returns {Object} - Novo estado com intervalos limpos
 */
const pararMonitores = (estado) => {
  const { intervalos, registrador } = estado;

  // Limpar todos os intervalos existentes
  Object.values(intervalos).forEach(intervalo => {
    if (intervalo) clearInterval(intervalo);
  });

  registrador.info('Monitores de saúde parados');

  return {
    ...estado,
    intervalos: {
      batimento: null,
      memoria: null,
      verificacaoConexao: null,
      watchdogInterno: null,
      watchdogSecundario: null
    }
  };
};

// ======= INTERFACE PÚBLICA =======

// Variável para armazenar a instância única do monitor
let monitor = null;

/**
 * Cria uma nova instância do monitor de saúde
 * @param {Object} registrador - Objeto logger para registro de eventos
 * @param {Object} clienteWhatsApp - Instância do cliente WhatsApp
 * @param {Object} opcoes - Opções de configuração
 */
const criar = (registrador, clienteWhatsApp, opcoes = {}) => {
  if (monitor) {
    registrador.warn('MonitorSaude já existe! Parando monitores existentes antes de criar novos.');
    monitor.parar();
  }

  // Criar estado inicial
  const estado = criarEstadoInicial(registrador, clienteWhatsApp, opcoes);

  registrador.info('Monitor de saúde inicializado');

  // Criar interface pública (o que é exposto para o código cliente)
  monitor = {
    estado,

    // Métodos públicos que mantêm a mesma interface da versão anterior
    iniciar() {
      this.estado = iniciarMonitores(this.estado);

      // Inicializar watchdog e arquivo de marca temporal
      try {
        if (!fs.existsSync('./temp')) {
          fs.mkdirSync('./temp', { recursive: true });
        }
        fs.writeFileSync('./temp/ultimo_check.txt', Date.now().toString(), 'utf8');
        registrador.info('Watchdog interno iniciado para detectar paralisação total');
      } catch (erro) {
        registrador.error(`Erro ao inicializar watchdog: ${erro.message}`);
      }

      return this;
    },

    parar() {
      this.estado = pararMonitores(this.estado);
      return this;
    },

    // Método para recuperação segura de transações
    async inicializarRecuperacaoSegura() {
      const resultado = await inicializarRecuperacaoSegura(this.estado);
      return resultado.notificacoesProcessadas;
    },

    // Método para verificar estado da conexão (útil para chamadas externas)
    async verificarConexao() {
      this.estado = await gerenciarEstadoConexao(this.estado);
      return this.estado.contadores.falhasConsecutivas === 0;
    },

    // Método para configurar opções
    configurarOpcoes(novasOpcoes) {
      this.estado = {
        ...this.estado,
        config: {
          ...this.estado.config,
          ...novasOpcoes
        }
      };
      return this;
    }
  };

  return monitor;
};

module.exports = { criar };