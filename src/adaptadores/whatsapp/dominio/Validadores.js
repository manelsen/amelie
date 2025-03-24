/**
 * Validadores - Funções puras para validação de mensagens
 */
const _ = require('lodash/fp');
const { Resultado } = require('../../../utilitarios/Ferrovia');

// Verifica se uma mensagem deve ser processada
const validarMensagem = _.curry((registrador, mensagensProcessadas, mensagem) => {
  if (!mensagem || !mensagem.id) {
    registrador.debug("Mensagem inválida recebida");
    return Resultado.falha(new Error("Mensagem inválida"));
  }

  // Verificar deduplicação
  const mensagemId = mensagem.id._serialized;

  if (mensagensProcessadas.has(mensagemId)) {
    registrador.debug(`Mensagem ${mensagemId} já processada. Ignorando.`);
    return Resultado.falha(new Error("Mensagem duplicada"));
  }

  // Marcar mensagem como processada
  mensagensProcessadas.set(mensagemId, Date.now());

  return Resultado.sucesso({ mensagem, mensagemId });
});

// Verifica se é mensagem de sistema
const verificarMensagemSistema = _.curry((registrador, dados) => {
  const { mensagem, mensagemId } = dados;

  // Predicados para verificação de sistema
  const ehNotificacao = msg => ['notification', 'e2e_notification', 
    'notification_template', 'call_log'].includes(msg.type);
    
  const temMetadataSistema = msg => msg._data && (
    msg._data.subtype === 'system' ||
    (msg._data.star === true && !msg.body && !msg.hasMedia) ||
    msg._data.isStatusV3 === true ||
    (msg._data.isViewOnce === true && !msg.body)
  );
  
  const temIdNotificacao = msg => msg.id && msg.id._serialized && 
    msg.id._serialized.includes('NOTIFICATION');
  
  const ehVazia = msg => !msg.body && !msg.hasMedia;

  // Testar todas as condições usando lodash/fp
  const ehSistema = _.overSome([
    ehVazia,
    ehNotificacao,
    temMetadataSistema,
    temIdNotificacao
  ])(mensagem);

  if (ehSistema) {
    registrador.debug(`Mensagem ${mensagemId} identificada como mensagem de sistema. Ignorando.`);
    return Resultado.falha(new Error("Mensagem de sistema"));
  }

  return Resultado.sucesso(dados);
});

// Verifica se é um comando
const verificarTipoMensagem = _.curry((registrador, dados) => {
  const { mensagem } = dados;

  // Verificação detalhada com logs para debug
  const ehComandoValido = msg => {
    // Primeiro verificamos se a mensagem tem corpo
    if (!msg.body) {
      registrador.debug(`Mensagem sem corpo: ${JSON.stringify(msg.id)}`);
      return false;
    }
    
    // Depois se começa com ponto
    if (!msg.body.startsWith('.')) {
      registrador.debug(`Mensagem não inicia com ponto: ${msg.body}`);
      return false;
    }
    
    // Verificar comprimento mínimo
    if (msg.body.length <= 1) {
      registrador.debug(`Mensagem muito curta: ${msg.body}`);
      return false;
    }
    
    // Extrair o comando propriamente dito
    const comando = msg.body.substring(1).split(' ')[0].toLowerCase();
    registrador.debug(`Comando extraído: "${comando}"`);
    
    // Lista de comandos válidos
    const comandosValidos = ['reset', 'ajuda', 'prompt', 'config', 'users', 'cego',
      'audio', 'video', 'imagem', 'longo', 'curto', 'filas', 'legenda'];
    
    // Verificar se está na lista
    const ehValido = comandosValidos.includes(comando);
    
    // Log do resultado
    if (ehValido) {
      registrador.info(`✅ Comando válido detectado: ${comando}`);
    } else {
      registrador.debug(`❌ Comando não reconhecido: ${comando}`);
    }
    
    return ehValido;
  };

  // Definir tipo usando cond com logs explícitos
  const tipo = _.cond([
    [ehComandoValido, () => 'comando'],
    [msg => msg.hasMedia, () => {
      registrador.debug(`Mensagem com mídia detectada`);
      return 'midia';
    }],
    [_.stubTrue, () => {
      registrador.debug(`Mensagem de texto comum: ${mensagem.body?.substring(0, 20)}...`);
      return 'texto';
    }]
  ])(mensagem);

  registrador.debug(`Mensagem classificada como: ${tipo}`);
  return Resultado.sucesso({ ...dados, tipo });
});

module.exports = {
  validarMensagem,
  verificarMensagemSistema,
  verificarTipoMensagem
};