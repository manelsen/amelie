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

// Função auxiliar para normalizar texto (remover acentos, minúsculas, trim)
const normalizarTexto = (texto) => {
  if (!texto) return '';
  return texto
    .toString()
    .normalize('NFD') // Decompor caracteres acentuados
    .replace(/[\u0300-\u036f]/g, '') // Remover diacríticos (acentos)
    .toLowerCase() // Converter para minúsculas
    .trim(); // Remover espaços no início/fim
};

// Verifica o tipo da mensagem (comando, midia, texto)
const verificarTipoMensagem = _.curry((registrador, registroComandos, dados) => {
  const { mensagem } = dados;
  let tipo = 'texto'; // Padrão
  let comandoNormalizado = null;

  // 1. Normalizar o corpo da mensagem
  const textoOriginal = mensagem.body || '';
  registrador.debug(`[verificarTipoMensagem] Texto Original: "${textoOriginal}"`);
  const textoNormalizado = normalizarTexto(textoOriginal);
  registrador.debug(`[verificarTipoMensagem] Texto Normalizado: "${textoNormalizado}"`);

  // 2. Verificar se existe texto normalizado
  if (textoNormalizado) {
    // 3. Remover o ponto inicial, se existir, APÓS normalizar
    let textoParaVerificar = textoNormalizado;
    if (textoParaVerificar.startsWith('.')) {
      textoParaVerificar = textoParaVerificar.substring(1).trim(); // Remove o ponto e espaços adjacentes
      registrador.debug(`[verificarTipoMensagem] Texto após remover ponto: "${textoParaVerificar}"`);
    }

    // 4. Extrair a primeira palavra do texto ajustado
    const primeiraPalavra = textoParaVerificar.split(' ')[0];
    registrador.debug(`[verificarTipoMensagem] Primeira Palavra (final): "${primeiraPalavra}"`);

    // 5. Verificar se a primeira palavra corresponde a um comando registrado
    // Obtém a lista de nomes de comandos e normaliza-os da mesma forma
    const comandosRegistrados = registroComandos.listarComandos(); // Obter objetos completos
    const nomesComandosOriginais = comandosRegistrados.map(cmd => cmd.nome);
    const nomesComandosRegistrados = nomesComandosOriginais.map(nome => normalizarTexto(nome));
    registrador.debug(`[verificarTipoMensagem] Nomes Comandos Registrados (Normalizados): [${nomesComandosRegistrados.join(', ')}]`);

    // Comparar a 'primeiraPalavra' (já sem ponto) com a lista normalizada
    const ehComando = primeiraPalavra && nomesComandosRegistrados.includes(primeiraPalavra);
    registrador.debug(`[verificarTipoMensagem] Verificando se "${primeiraPalavra}" está em [${nomesComandosRegistrados.join(', ')}]: ${ehComando}`);
    if (ehComando) {
      tipo = 'comando';
      comandoNormalizado = primeiraPalavra; // Guarda o comando normalizado encontrado
      registrador.info(`Comando detectado: ${comandoNormalizado} (Texto original: "${mensagem.body}")`);
    } else {
       registrador.debug(`Palavra "${primeiraPalavra}" não é um comando registrado.`);
    }
  } else {
     registrador.debug(`Mensagem sem corpo ou texto normalizado vazio.`);
  }

  // 6. Se não for comando, verificar se tem mídia (incluindo documento)
  if (tipo !== 'comando' && mensagem.hasMedia) {
    tipo = 'midia';
    registrador.debug(`Mensagem com mídia detectada (type: ${mensagem.type}).`); // Log ajustado
  }

  // 7. Se não for comando nem mídia, é texto (ou vazia, tratada antes)
  if (tipo === 'texto') {
     registrador.debug(`Mensagem classificada como texto: ${mensagem.body?.substring(0, 20)}...`);
  }

  // 8. Retornar o resultado com o tipo e o comando normalizado (se houver)
  registrador.debug(`Mensagem classificada como: ${tipo}${comandoNormalizado ? ` (${comandoNormalizado})` : ''}`);
  return Resultado.sucesso({ ...dados, tipo, comandoNormalizado });
});

module.exports = {
  validarMensagem,
  verificarMensagemSistema,
  verificarTipoMensagem
};