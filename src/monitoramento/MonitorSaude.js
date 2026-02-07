/**
 * MonitorSaude - Monitora a saúde do sistema
 * 
 * Implementado seguindo princípios funcionais com estado imutável.
 */

const fs = require('fs');
const path = require('path');

// ======= FUNÇÕES PURAS =======

const criarConfiguracoes = (opcoes = {}) => ({
  intervaloBatimento: opcoes.intervaloBatimento || 20000,
  intervaloMemoria: opcoes.intervaloMemoria || 300000,
  intervaloVerificacaoConexao: opcoes.intervaloVerificacaoConexao || 60000,
  limiteAlertaMemoria: opcoes.limiteAlertaMemoria || 1024,
  limiteCriticoMemoria: opcoes.limiteCriticoMemoria || 1536,
  limiteReconexoes: opcoes.limiteReconexoes || 5
});

const criarEstadoInicial = (registrador, clienteWhatsApp, opcoes = {}) => ({
  registrador,
  clienteWhatsApp,
  config: criarConfiguracoes(opcoes),
  contadores: { batimentos: 0, falhasConsecutivas: 0 },
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

const formatarTempoAtivo = (milissegundos) => {
  const segundosTotais = Math.floor(milissegundos / 1000);
  const dias = Math.floor(segundosTotais / (24 * 60 * 60));
  const horas = Math.floor((segundosTotais % (24 * 60 * 60)) / (60 * 60));
  const minutos = Math.floor((segundosTotais % (60 * 60)) / 60);
  const segundos = segundosTotais % 60;

  const partes = [];
  if (dias > 0) partes.push(`${dias} ${dias === 1 ? 'dia' : 'dias'}`);
  if (horas > 0) partes.push(`${horas} ${horas === 1 ? 'hora' : 'horas'}`);
  if (minutos > 0) partes.push(`${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`);
  if (segundos > 0 || partes.length === 0) partes.push(`${segundos} ${segundos === 1 ? 'segundo' : 'segundos'}`);

  if (partes.length === 1) return partes[0];
  if (partes.length === 2) return partes.join(' e ');
  const ultimaParte = partes.pop();
  return partes.join(', ') + ' e ' + ultimaParte;
};

const verificarChromeVivo = async (cliente, registrador) => {
  try {
    if (!cliente || !cliente.pupBrowser) return true;
    const browser = cliente.pupBrowser;
    const pages = await Promise.race([
      browser.pages().catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 5000))
    ]);
    if (!pages) {
      registrador.warn('Não foi possível acessar as páginas do Chrome - possível crash');
      return true;
    }
    if (!cliente.pupPage) {
      registrador.warn('Página principal do WhatsApp não encontrada no Puppeteer');
      return true;
    }
    const podeExecutarJS = await Promise.race([
      cliente.pupPage.evaluate(() => true).catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(false), 5000))
    ]);
    if (!podeExecutarJS) {
      registrador.warn('Não é possível executar JavaScript na página - Chrome provavelmente travado');
      return true;
    }
    if (browser.process() && browser.process().pid) {
      try { process.kill(browser.process().pid, 0); } 
      catch (e) {
        registrador.warn(`Processo do Chrome (PID ${browser.process().pid}) não está mais ativo`);
        return true;
      }
    }
    return false;
  } catch (erro) {
    registrador.error(`Erro ao verificar estado do Chrome: ${erro.message}`);
    return true;
  }
};

const verificarMensagensRecentes = (registrador) => {
  try {
    const caminhoLog = './logs/bot.log';
    if (!fs.existsSync(caminhoLog)) return false;
    let conteudoLog;
    try {
      const stats = fs.statSync(caminhoLog);
      const tamanhoLeitura = Math.min(stats.size, 50 * 1024);
      const buffer = Buffer.alloc(tamanhoLeitura);
      const fd = fs.openSync(caminhoLog, 'r');
      fs.readSync(fd, buffer, 0, tamanhoLeitura, stats.size - tamanhoLeitura);
      fs.closeSync(fd);
      conteudoLog = buffer.toString();
    } catch (erroLeitura) {
      registrador.error(`Erro ao ler arquivo de log: ${erroLeitura.message}`);
      return false;
    }
    const linhasRecentes = conteudoLog.split('\n').slice(-100);
    const agora = new Date();
    const doisMinutosAtras = new Date(agora.getTime() - 2 * 60 * 1000);
    const padroesAtividade = ['Mensagem de ', 'Resposta:', 'processando mídia'];
    for (const linha of linhasRecentes) {
      if (!padroesAtividade.some(padrao => linha.includes(padrao))) continue;
      const timestampMatch = linha.match(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
      if (!timestampMatch) continue;
      try {
        const dataLinha = new Date(timestampMatch[0]);
        if (dataLinha >= doisMinutosAtras) return true;
      } catch (e) {}
    }
    return false;
  } catch (erro) {
    registrador.error(`Erro ao verificar mensagens recentes: ${erro.message}`);
    return false;
  }
};

const verificarConexaoAtiva = async (estado) => {
  const { clienteWhatsApp, registrador } = estado;
  try {
    if (!clienteWhatsApp || !clienteWhatsApp.getRawClient() || !clienteWhatsApp.getRawClient().info) {
      return { conectado: false, diagnostico: { motivo: "Cliente WhatsApp não inicializado" } };
    }
    const rawClient = clienteWhatsApp.getRawClient();
    const chromeMorto = await verificarChromeVivo(rawClient, registrador);
    if (chromeMorto) {
      registrador.error('❌ Chrome do Puppeteer morreu ou está inacessível!');
      return { conectado: false, diagnostico: { motivo: "Chrome morto", requerReinicioImediato: true } };
    }
    const temId = Boolean(rawClient.info.wid);
    let estadoConexaoPuppeteer = false;
    if (rawClient.pupPage) {
      try {
        estadoConexaoPuppeteer = await rawClient.pupPage.evaluate(() => {
          return Boolean(
            (window.Store && window.Store.Conn) ||
            (window.WAPI && window.WAPI.isConnected()) ||
            (window.WWebJS && window.WWebJS.isConnected) ||
            document.querySelector('[data-icon=":"]') !== null
          );
        }).catch(() => false);
      } catch (e) {}
    }
    const mensagemRecente = verificarMensagensRecentes(registrador);
    const envioRecente = (clienteWhatsApp.getUltimoEnvio() && (Date.now() - clienteWhatsApp.getUltimoEnvio() < 3 * 60 * 1000));
    const sinaisPositivos = [temId, estadoConexaoPuppeteer, mensagemRecente, envioRecente].filter(Boolean).length;
    const estaConectado = sinaisPositivos >= 2;
    return { conectado: estaConectado, diagnostico: { temId, estadoConexaoPuppeteer, mensagemRecente, envioRecente, sinaisPositivos } };
  } catch (erro) {
    registrador.error(`Erro ao verificar estado da conexão: ${erro.message}`);
    return { conectado: false, diagnostico: { erro: erro.message } };
  }
};

const verificarMemoria = (estado) => {
  const { registrador, config } = estado;
  try {
    const usoMemoria = process.memoryUsage();
    const heapUsadoMB = Math.round(usoMemoria.heapUsed / 1024 / 1024);
    const rssMB = Math.round(usoMemoria.rss / 1024 / 1024);
    let resultado = { estado: 'normal' };
    if (heapUsadoMB > config.limiteAlertaMemoria || rssMB > config.limiteAlertaMemoria) {
      registrador.warn(`⚠️ Alto uso de memória detectado: Heap ${heapUsadoMB}MB / RSS ${rssMB}MB`);
      resultado = { ...resultado, estado: 'alerta' };
      if (global.gc) {
        registrador.info('Solicitando coleta de lixo...');
        global.gc();
      }
    }
    if (heapUsadoMB > config.limiteCriticoMemoria || rssMB > config.limiteCriticoMemoria) {
      registrador.error(`⚠️ ALERTA CRÍTICO: Uso de memória excedeu limite crítico! RSS: ${rssMB}MB, Heap: ${heapUsadoMB}MB`);
      resultado = { ...resultado, estado: 'critico' };
    }
    return { resultado, metricas: { heapUsadoMB, rssMB } };
  } catch (erro) {
    registrador.error(`Erro ao verificar memória: ${erro.message}`);
    return { resultado: { estado: 'erro', mensagem: erro.message }, metricas: {} };
  }
};

const executarBatimento = async (estado, updateEstado) => {
  const { registrador, timestamps, contadores } = estado;
  try {
    const agora = Date.now();
    const temAtividadeRecente = verificarMensagensRecentes(registrador);
    const { conectado: conexaoAtiva, diagnostico } = await verificarConexaoAtiva(estado);

    if (!conexaoAtiva && !temAtividadeRecente) {
      registrador.warn('❌ Conexão WhatsApp inativa - batimento não emitido');
      if (diagnostico && diagnostico.requerReinicioImediato) {
        return { tipo: 'reinicioImediato', motivo: 'Chrome morto' };
      }
      return { sucesso: false, motivo: 'Conexão inativa' };
    }

    const novoContadorBatimentos = contadores.batimentos + 1;
    if (novoContadorBatimentos % 100 === 0) {
      const tempoAtivo = formatarTempoAtivo(agora - timestamps.inicioSistema);
      registrador.info(`💜 #${novoContadorBatimentos} - Amélie ativa há ${tempoAtivo}`);
    }

    let resultadoMemoria = null;
    if (novoContadorBatimentos % 5 === 0) {
      resultadoMemoria = verificarMemoria(estado);
    }

    updateEstado({
      ...estado,
      contadores: { ...contadores, batimentos: novoContadorBatimentos },
      timestamps: { ...timestamps, ultimoBatimento: agora },
      resultadoBatimento: { sucesso: true, temAtividadeRecente, conexaoAtiva, diagnostico },
      resultadoMemoria
    });
    return { sucesso: true };
  } catch (erro) {
    registrador.error(`Erro ao emitir batimento: ${erro.message}`);
    return { sucesso: false, erro: erro.message };
  }
};

const salvarEstadoCritico = (estado) => {
  const { registrador, timestamps, contadores } = estado;
  try {
    const diretorioDiagnostico = './diagnosticos';
    if (!fs.existsSync(diretorioDiagnostico)) fs.mkdirSync(diretorioDiagnostico, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const arquivoDiagnostico = path.join(diretorioDiagnostico, `travamento_${timestamp}.json`);
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

const recuperacaoEmergencia = async (estado, updateEstado) => {
  const { registrador, clienteWhatsApp, timestamps } = estado;
  registrador.error('🚨 Procedimento de Recuperação de Emergência 🚨');
  try {
    if (global.gc) { registrador.info('Forçando coleta de lixo...'); global.gc(); }
    salvarEstadoCritico(estado);
    try {
      const diretorioPerfil = path.join(process.cwd(), '.wwebjs_auth/session-principal');
      const arquivoLock = path.join(diretorioPerfil, 'SingletonLock');
      if (fs.existsSync(arquivoLock)) {
        const stats = fs.statSync(arquivoLock);
        if ((Date.now() - stats.mtimeMs) / 1000 > 30) {
          registrador.info('🔓 Removendo arquivo de bloqueio do Chrome...');
          fs.unlinkSync(arquivoLock);
        }
      }
    } catch (e) {}

    await clienteWhatsApp.reiniciarCompleto();
    registrador.info('✅ Recuperação de emergência concluída');

    updateEstado({
      ...estado,
      contadores: { ...estado.contadores, falhasConsecutivas: 0 },
      timestamps: { ...timestamps, ultimoBatimento: Date.now(), ultimaAtividadeSistema: Date.now() }
    });
  } catch (erro) {
    registrador.error(`Falha na recuperação de emergência: ${erro.message}`);
  }
};

const gerenciarEstadoConexao = async (estado, updateEstado) => {
  const { registrador, clienteWhatsApp, timestamps, contadores, config } = estado;
  try {
    const { conectado: conexaoAtiva, diagnostico } = await verificarConexaoAtiva(estado);
    const ultimoBatimentoAntigo = timestamps.ultimoBatimento < Date.now() - (2 * 60 * 1000);

    if (diagnostico && diagnostico.requerReinicioImediato) {
      await recuperacaoEmergencia(estado, updateEstado);
      return;
    }

    if (!conexaoAtiva || ultimoBatimentoAntigo) {
      const novasFalhasConsecutivas = contadores.falhasConsecutivas + 1;
      registrador.warn(`Falha de conexão detectada (${novasFalhasConsecutivas}/${config.limiteReconexoes})`);

      if (novasFalhasConsecutivas >= config.limiteReconexoes) {
        await clienteWhatsApp.reiniciarCompleto();
        updateEstado({
          ...estado,
          contadores: { ...contadores, falhasConsecutivas: 0 },
          timestamps: { ...timestamps, ultimoBatimento: Date.now() }
        });
      } else {
        await clienteWhatsApp.reconectar();
        updateEstado({
          ...estado,
          contadores: { ...contadores, falhasConsecutivas: novasFalhasConsecutivas }
        });
      }
    } else if (contadores.falhasConsecutivas > 0) {
      registrador.info(`Conexão normalizada`);
      updateEstado({ ...estado, contadores: { ...contadores, falhasConsecutivas: 0 } });
    }
  } catch (erro) {
    registrador.error(`Erro na verificação de conexão: ${erro.message}`);
  }
};

const inicializarRecuperacaoSegura = async (estado) => {
  const { registrador, clienteWhatsApp } = estado;
  registrador.info('🚀 Iniciando procedimento de recuperação de transações...');
  global.sistemaRecuperando = true;
  try {
    if (!clienteWhatsApp.getPronto()) {
      await new Promise(resolve => {
        const verificador = setInterval(() => {
          if (clienteWhatsApp.getPronto()) { clearInterval(verificador); resolve(); }
        }, 1000);
      });
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
    const processadas = await clienteWhatsApp.processarNotificacoesPendentes();
    global.sistemaRecuperando = false;
    registrador.info(`✅ Recuperação segura concluída! ${processadas} notificações`);
    return processadas;
  } catch (erro) {
    registrador.error(`❌ Erro na recuperação segura: ${erro.message}`);
    global.sistemaRecuperando = false;
    return 0;
  }
};

// ======= INTERFACE PÚBLICA (FÁBRICA) =======

const criar = (registrador, clienteWhatsApp, opcoes = {}) => {
  let estado = criarEstadoInicial(registrador, clienteWhatsApp, opcoes);

  const updateEstado = (novoEstado) => {
    estado = novoEstado;
  };

  const parar = () => {
    Object.values(estado.intervalos).forEach(intervalo => { if (intervalo) clearInterval(intervalo); });
    updateEstado({
      ...estado,
      intervalos: { batimento: null, memoria: null, verificacaoConexao: null, watchdogInterno: null, watchdogSecundario: null }
    });
    registrador.info('Monitores de saúde parados');
  };

  const iniciar = () => {
    parar();
    const intervalos = {
      batimento: setInterval(async () => {
        const res = await executarBatimento(estado, updateEstado);
        if (res.tipo === 'reinicioImediato') await recuperacaoEmergencia(estado, updateEstado);
      }, estado.config.intervaloBatimento),
      memoria: setInterval(async () => {
        const res = verificarMemoria(estado);
        if (res.resultado.estado === 'critico') await recuperacaoEmergencia(estado, updateEstado);
      }, estado.config.intervaloMemoria),
      verificacaoConexao: setInterval(async () => {
        await gerenciarEstadoConexao(estado, updateEstado);
      }, estado.config.intervaloVerificacaoConexao),
      watchdogInterno: setInterval(() => {
        const agora = Date.now();
        try { fs.writeFileSync('./temp/ultimo_check.txt', agora.toString(), 'utf8'); } catch (e) {}
        updateEstado({ ...estado, timestamps: { ...estado.timestamps, ultimaAtividadeSistema: agora } });
      }, 30000),
      watchdogSecundario: setInterval(async () => {
        try {
          const ultimo = parseInt(fs.readFileSync('./temp/ultimo_check.txt', 'utf8'));
          if (Date.now() - ultimo > 120000) await recuperacaoEmergencia(estado, updateEstado);
        } catch (e) {}
      }, 60000)
    };
    updateEstado({ ...estado, intervalos });
    executarBatimento(estado, updateEstado);
    registrador.info('Monitores de saúde iniciados');
  };

  return {
    iniciar,
    parar,
    inicializarRecuperacaoSegura: () => inicializarRecuperacaoSegura(estado),
    verificarConexao: async () => {
      await gerenciarEstadoConexao(estado, updateEstado);
      return estado.contadores.falhasConsecutivas === 0;
    },
    configurarOpcoes: (novas) => {
      updateEstado({ ...estado, config: { ...estado.config, ...novas } });
    }
  };
};

module.exports = { criar };
