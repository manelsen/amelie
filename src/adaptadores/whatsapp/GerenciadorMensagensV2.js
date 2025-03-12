/**

 * GerenciadorMensagens - Módulo para processamento de mensagens do WhatsApp
 * 
 * Implementação refatorada usando programação funcional, padrão Railway e composição com Lodash/FP.
   */

const _ = require('lodash/fp');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Estrutura Resultado para tratamento funcional de erros (Padrão Railway)
const Resultado = {
  sucesso: (dados) => ({ sucesso: true, dados, erro: null }),
  falha: (erro) => ({ sucesso: false, dados: null, erro }),

  // Funções utilitárias para encadeamento
  mapear: (resultado, fn) => resultado.sucesso ? Resultado.sucesso(fn(resultado.dados)) : resultado,
  encadear: (resultado, fn) => resultado.sucesso ? fn(resultado.dados) : resultado,

  // Manipuladores de resultado
  dobrar: (resultado, aoSucesso, aoFalhar) => 
    resultado.sucesso ? aoSucesso(resultado.dados) : aoFalhar(resultado.erro)
};

/**

 * Funções puras para validação e processamento
   */

// Verifica se uma mensagem deve ser processada
const validarMensagem = (registrador, mensagensProcessadas) => (mensagem) => {
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
};

// Verifica se é mensagem de sistema
const verificarMensagemSistema = (registrador) => (dados) => {
  const { mensagem, mensagemId } = dados;

  // Implementação completa da verificação de sistema
  const ehSistema = 
    (!mensagem.body && !mensagem.hasMedia) || 
    mensagem.type === 'notification' || 
    mensagem.type === 'e2e_notification' ||
    mensagem.type === 'notification_template' || 
    mensagem.type === 'call_log' ||
    (mensagem._data && (
      mensagem._data.subtype === 'system' ||
      (mensagem._data.star === true && !mensagem.body && !mensagem.hasMedia) ||
      mensagem._data.isStatusV3 === true ||
      mensagem._data.isViewOnce === true && !mensagem.body
    )) ||
    (mensagem.id && mensagem.id._serialized && mensagem.id._serialized.includes('NOTIFICATION'));

  if (ehSistema) {
    registrador.debug(`Mensagem ${mensagemId} identificada como mensagem de sistema. Ignorando.`);
    return Resultado.falha(new Error("Mensagem de sistema"));
  }

  return Resultado.sucesso(dados);
};

// Remove emojis de um texto
const removerEmojis = (texto) => {
  return texto.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F0FF}\u{1F100}-\u{1F2FF}]/gu, '');
};

// Obtém informações do chat
const obterInformacoesChat = (registrador) => async (dados) => {
  try {
    const { mensagem } = dados;
    const chat = await mensagem.getChat();
    await chat.sendSeen();
    

    const chatId = chat.id._serialized;
    const ehGrupo = chatId.endsWith('@g.us');
    
    return Resultado.sucesso({ 
      ...dados, 
      chat, 
      chatId,
      ehGrupo 
    });

  } catch (erro) {
    registrador.error(`Erro ao obter informações do chat: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

// Verifica se deve responder em grupo
const verificarRespostaGrupo = (clienteWhatsApp) => async (dados) => {
  const { mensagem, chat, ehGrupo } = dados;

  // Se não for grupo, sempre processa
  if (!ehGrupo) {
    return Resultado.sucesso({ ...dados, deveResponder: true });
  }

  // Verificar critérios para responder em grupo
  try {
    const deveResponder = await clienteWhatsApp.deveResponderNoGrupo(mensagem, chat);
    

    if (!deveResponder) {
      return Resultado.falha(new Error("Não atende critérios para resposta em grupo"));
    }
    
    return Resultado.sucesso({ ...dados, deveResponder: true });

  } catch (erro) {
    return Resultado.falha(erro);
  }
};

// Verifica se é um comando
const verificarTipoMensagem = (registrador) => (dados) => {
  const { mensagem } = dados;

  // Verificar se é realmente um comando (começa com ponto e tem pelo menos um caractere após)
  if (mensagem.body && mensagem.body.startsWith('.') && mensagem.body.length > 1) {
    const comando = mensagem.body.substring(1).split(' ')[0];
    // Lista de comandos válidos para verificação adicional
    const comandosValidos = ['reset', 'ajuda', 'prompt', 'config', 'users', 'cego', 
                          'audio', 'video', 'imagem', 'longo', 'curto', 'filas'];
    
    if (comandosValidos.includes(comando.toLowerCase())) {
      registrador.debug(`Comando válido detectado: ${mensagem.body}`);
      return Resultado.sucesso({ ...dados, tipo: 'comando' });
    }
    
    // Comando com formato correto mas não reconhecido
    registrador.debug(`Comando desconhecido ignorado: ${mensagem.body}`);
  }

  // Continuar com a verificação de mídia e texto
  if (mensagem.hasMedia) {
    return Resultado.sucesso({ ...dados, tipo: 'midia' });
  }

  return Resultado.sucesso({ ...dados, tipo: 'texto' });
};

// Infere o MIME type de um buffer de dados
const inferirMimeType = (buffer) => {
  if (!buffer || buffer.length < 12) {
    return 'application/octet-stream';
  }

  const bytesHex = buffer.slice(0, 12).toString('hex').toLowerCase();

  // Tipos de imagem
  if (bytesHex.startsWith('89504e47')) return 'image/png';
  if (bytesHex.startsWith('ffd8ff')) return 'image/jpeg';
  if (bytesHex.startsWith('47494638')) return 'image/gif';
  if (bytesHex.startsWith('424d')) return 'image/bmp';
  if (bytesHex.startsWith('52494646') && bytesHex.includes('57454250')) return 'image/webp';

  // Tipos de áudio
  if (bytesHex.startsWith('4944330') || bytesHex.startsWith('fffb')) return 'audio/mpeg';
  if (bytesHex.startsWith('52494646') && bytesHex.includes('57415645')) return 'audio/wav';
  if (bytesHex.startsWith('4f676753')) return 'audio/ogg';

  // Tipos de vídeo
  if (bytesHex.includes('66747970')) return 'video/mp4';
  if (bytesHex.startsWith('1a45dfa3')) return 'video/webm';
  if (bytesHex.startsWith('52494646') && bytesHex.includes('41564920')) return 'video/avi';
  if (bytesHex.startsWith('3026b275')) return 'video/x-ms-wmv';

  return 'application/octet-stream';
};

/**

 * Obter ou criar usuário
   */
   const obterOuCriarUsuario = (gerenciadorConfig, clienteWhatsApp, registrador) => async (remetente, chat) => {
     try {
   // Se temos gerenciadorConfig, usar o método dele
   if (gerenciadorConfig) {
     const usuario = await gerenciadorConfig.obterOuCriarUsuario(remetente, clienteWhatsApp.cliente);

     // Garantir que sempre temos um nome não-undefined
     if (!usuario.name || usuario.name === 'undefined') {
       const idCurto = remetente.substring(0, 8).replace(/[^0-9]/g, '');
       usuario.name = `Usuário${idCurto}`;
     }

     return Resultado.sucesso(usuario);
   }

   // Implementação alternativa caso o gerenciadorConfig não esteja disponível
   const contato = await clienteWhatsApp.cliente.getContactById(remetente);

   let nome = contato.pushname || contato.name || contato.shortName;

   if (!nome || nome.trim() === '' || nome === 'undefined') {
     const idSufixo = remetente.substring(0, 6).replace(/[^0-9]/g, '');
     nome = `Usuário${idSufixo}`;
   }

   return Resultado.sucesso({
     id: remetente,
     name: nome,
     joinedAt: new Date()
   });
     } catch (erro) {
   registrador.error(`Erro ao obter informações do usuário: ${erro.message}`);
   const idSufixo = remetente.substring(0, 6).replace(/[^0-9]/g, '');
   return Resultado.sucesso({
     id: remetente,
     name: `Usuário${idSufixo}`,
     joinedAt: new Date()
   });
     }
   };

/**

 * Processamento de transações
   */
   const criarTransacao = (gerenciadorTransacoes, registrador) => async (mensagem, chat, remetente) => {
     try {
   const transacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
   registrador.debug(`Nova transação criada: ${transacao.id} para mensagem de ${remetente.name}`);
   return Resultado.sucesso(transacao);
     } catch (erro) {
   registrador.error(`Erro ao criar transação: ${erro.message}`);
   return Resultado.falha(erro);
     }
   };

const adicionarDadosRecuperacao = (gerenciadorTransacoes, registrador) => async (transacaoId, dados) => {
  try {
    await gerenciadorTransacoes.adicionarDadosRecuperacao(transacaoId, dados);
    return Resultado.sucesso(true);
  } catch (erro) {
    registrador.error(`Erro ao adicionar dados de recuperação: ${erro.message}`);
    return Resultado.sucesso(false); // Continuar mesmo assim
  }
};

const marcarComoProcessando = (gerenciadorTransacoes, registrador) => async (transacaoId) => {
  try {
    await gerenciadorTransacoes.marcarComoProcessando(transacaoId);
    return Resultado.sucesso(true);
  } catch (erro) {
    registrador.error(`Erro ao marcar como processando: ${erro.message}`);
    return Resultado.sucesso(false); // Continuar mesmo assim
  }
};

const adicionarRespostaTransacao = (gerenciadorTransacoes, registrador) => async (transacaoId, resposta) => {
  try {
    await gerenciadorTransacoes.adicionarRespostaTransacao(transacaoId, resposta);
    return Resultado.sucesso(true);
  } catch (erro) {
    registrador.error(`Erro ao adicionar resposta à transação: ${erro.message}`);
    return Resultado.sucesso(false); // Continuar mesmo assim
  }
};

/**

 * Processamento de mensagens de texto
   */
   const processarMensagemTexto = (dependencias) => async (dados) => {
     const { registrador, gerenciadorAI, gerenciadorConfig, gerenciadorTransacoes, servicoMensagem, clienteWhatsApp } = dependencias;
     const { mensagem, chat, chatId } = dados;

  try {
    // Obter informações do remetente
    const resultadoRemetente = await obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(mensagem.author || mensagem.from, chat);
    const remetente = resultadoRemetente.dados;
    

    // Criar transação para esta mensagem
    const resultadoTransacao = await criarTransacao(gerenciadorTransacoes, registrador)(mensagem, chat, remetente);
    
    if (!resultadoTransacao.sucesso) {
      return resultadoTransacao;
    }
    
    const transacao = resultadoTransacao.dados;
    
    // Adicionar dados para recuperação
    await adicionarDadosRecuperacao(gerenciadorTransacoes, registrador)(
      transacao.id, 
      {
        tipo: 'texto',
        remetenteId: mensagem.from,
        remetenteNome: remetente.name,
        chatId: chatId,
        textoOriginal: mensagem.body,
        timestampOriginal: mensagem.timestamp
      }
    );
    
    // Marcar como processando
    await marcarComoProcessando(gerenciadorTransacoes, registrador)(transacao.id);
    
    // Obter histórico do chat
    const historico = await clienteWhatsApp.obterHistoricoMensagens(chatId);
    
    // Verificar se a última mensagem já é a atual
    const ultimaMensagem = historico.length > 0 ? historico[historico.length - 1] : '';
    const mensagemUsuarioAtual = `${remetente.name}: ${mensagem.body}`;
    
    // Só adiciona a mensagem atual se ela não for a última do histórico
    const textoHistorico = ultimaMensagem.includes(mensagem.body)
      ? `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}`
      : `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}\n${mensagemUsuarioAtual}`;
    
    // Obter configuração e gerar resposta da IA
    const config = await gerenciadorConfig.obterConfig(chatId);
    const resposta = await gerenciadorAI.processarTexto(textoHistorico, config);
    
    // Adicionar resposta à transação
    await adicionarRespostaTransacao(gerenciadorTransacoes, registrador)(transacao.id, resposta);
    
    // Enviar a resposta
    try {
      await servicoMensagem.enviarResposta(mensagem, resposta, transacao.id);
      registrador.info(`Resposta de mensagem de texto enviada - ${transacao.id}`);
      return Resultado.sucesso({ transacao, resposta });
    } catch (erroEnvio) {
      registrador.error(`Erro ao enviar mensagem: ${erroEnvio.message}`);
      return Resultado.falha(erroEnvio);
    }

  } catch (erro) {
    registrador.error(`Erro ao processar mensagem de texto: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

/**

 * Processamento de comandos
   */
   const processarComando = (dependencias) => async (dados) => {
     const { registrador, servicoMensagem, gerenciadorConfig } = dependencias;
     const { mensagem, chatId } = dados;

  try {
    // Extrair comando e argumentos
    const [comando, ...args] = mensagem.body.slice(1).split(' ');
    registrador.debug(`Processando comando: ${comando}, Argumentos: ${args.join(' ')}`);
    

    // Mapear comandos para funções
    const mapaComandos = {
      'reset': () => tratarComandoReset(dependencias)(mensagem, chatId),
      'ajuda': () => tratarComandoAjuda(dependencias)(mensagem, chatId),
      'prompt': () => tratarComandoPrompt(dependencias)(mensagem, args, chatId),
      'config': () => tratarComandoConfig(dependencias)(mensagem, args, chatId),
      'users': () => tratarComandoUsers(dependencias)(mensagem, chatId),
      'cego': () => tratarComandoCego(dependencias)(mensagem, chatId),
      'audio': () => tratarComandoAlternarMidia(dependencias)('mediaAudio', 'transcrição de áudio')(mensagem, chatId),
      'video': () => tratarComandoAlternarMidia(dependencias)('mediaVideo', 'interpretação de vídeo')(mensagem, chatId),
      'imagem': () => tratarComandoAlternarMidia(dependencias)('mediaImage', 'audiodescrição de imagem')(mensagem, chatId),
      'longo': () => tratarComandoLongo(dependencias)(mensagem, chatId),
      'curto': () => tratarComandoCurto(dependencias)(mensagem, chatId),
      'filas': () => tratarComandoFilas(dependencias)(mensagem, args, chatId)
    };
    
    // Verificar se o comando existe
    if (mapaComandos[comando.toLowerCase()]) {
      return await mapaComandos[comando.toLowerCase()]();
    } else {
      await servicoMensagem.enviarResposta(
        mensagem, 
        'Comando desconhecido. Use .ajuda para ver os comandos disponíveis.'
      );
      return Resultado.falha(new Error(`Comando desconhecido: ${comando}`));
    }

  } catch (erro) {
    registrador.error(`Erro ao processar comando: ${erro.message}`);
    

    try {
      await servicoMensagem.enviarResposta(
        mensagem, 
        'Desculpe, ocorreu um erro ao processar seu comando.'
      );
    } catch (erroEnvio) {
      registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
    }
    
    return Resultado.falha(erro);

  }
};

/**

 * Implementações de comandos
   */
   const tratarComandoReset = (dependencias) => async (mensagem, chatId) => {
     const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  try {
    await gerenciadorConfig.resetarConfig(chatId);
    await gerenciadorConfig.limparPromptSistemaAtivo(chatId);
    

    await servicoMensagem.enviarResposta(
      mensagem,
      'Configurações resetadas para este chat. As transcrições de áudio e imagem foram habilitadas, e os prompts especiais foram desativados.'
    );
    
    registrador.debug(`Configurações resetadas para o chat ${chatId}`);
    return Resultado.sucesso(true);

  } catch (erro) {
    registrador.error(`Erro ao resetar configurações: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

const tratarComandoAjuda = (dependencias) => async (mensagem, chatId) => {
  const { servicoMensagem } = dependencias;

  const BOT_NAME = process.env.BOT_NAME || 'Amélie';
  const LINK_GRUPO_OFICIAL = process.env.LINK_GRUPO_OFICIAL || 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';

  const textoAjuda = `Olá! Eu sou a Amélie, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Esses são meus comandos disponíveis para configuração.

Use com um ponto antes da palavra de comando, sem espaço, e todas as letras são minúsculas.

Comandos:

.cego - Aplica configurações para usuários com deficiência visual

.audio - Liga/desliga a transcrição de áudio

.video - Liga/desliga a interpretação de vídeo

.imagem - Liga/desliga a audiodescrição de imagem

.longo - Usa audiodescrição longa e detalhada

.curto - Usa audiodescrição curta e concisa

.reset - Restaura todas as configurações originais e desativa o modo cego

.ajuda - Mostra esta mensagem de ajuda

Minha idealizadora é a Belle Utsch. 
Se quiser conhecer, fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da Amélie? O link é https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp
Meu repositório fica em https://github.com/manelsen/amelie`;

  await servicoMensagem.enviarResposta(mensagem, textoAjuda);
  return Resultado.sucesso(true);
};

const tratarComandoPrompt = (dependencias) => async (mensagem, args, chatId) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  try {
    const [subcomando, nome, ...resto] = args;

    switch (subcomando) {
      case 'set':
        if (nome && resto.length > 0) {
          const textoPrompt = resto.join(' ');
          await gerenciadorConfig.definirPromptSistema(chatId, nome, textoPrompt);
          await servicoMensagem.enviarResposta(mensagem, `System Instruction "${nome}" definida com sucesso.`);
        } else {
          await servicoMensagem.enviarResposta(mensagem, 'Uso correto: .prompt set <nome> <texto>');
        }
        break;
    
      case 'get':
        if (nome) {
          const prompt = await gerenciadorConfig.obterPromptSistema(chatId, nome);
          if (prompt) {
            await servicoMensagem.enviarResposta(mensagem, `System Instruction "${nome}":\n${prompt.text}`);
          } else {
            await servicoMensagem.enviarResposta(mensagem, `System Instruction "${nome}" não encontrada.`);
          }
        } else {
          await servicoMensagem.enviarResposta(mensagem, 'Uso correto: .prompt get <nome>');
        }
        break;
    
      case 'list':
        const prompts = await gerenciadorConfig.listarPromptsSistema(chatId);
        if (prompts.length > 0) {
          const listaPrompts = prompts.map(p => p.name).join(', ');
          await servicoMensagem.enviarResposta(mensagem, `System Instructions disponíveis: ${listaPrompts}`);
        } else {
          await servicoMensagem.enviarResposta(mensagem, 'Nenhuma System Instruction definida.');
        }
        break;
    
      case 'use':
        if (nome) {
          const prompt = await gerenciadorConfig.obterPromptSistema(chatId, nome);
          if (prompt) {
            await gerenciadorConfig.definirPromptSistemaAtivo(chatId, nome);
            await servicoMensagem.enviarResposta(mensagem, `System Instruction "${nome}" ativada para este chat.`);
          } else {
            await servicoMensagem.enviarResposta(mensagem, `System Instruction "${nome}" não encontrada.`);
          }
        } else {
          await servicoMensagem.enviarResposta(mensagem, 'Uso correto: .prompt use <nome>');
        }
        break;
    
      case 'clear':
        await gerenciadorConfig.limparPromptSistemaAtivo(chatId);
        await servicoMensagem.enviarResposta(mensagem, 'System Instruction removida. Usando o modelo padrão.');
        break;
    
      case 'delete':
        if (nome) {
          // Verificar se o prompt existe antes de tentar excluir
          const promptExiste = await gerenciadorConfig.obterPromptSistema(chatId, nome);
          if (promptExiste) {
            // Verificar se o prompt está ativo
            const config = await gerenciadorConfig.obterConfig(chatId);
            const estaAtivo = config.activePrompt === nome;
    
            // Excluir o prompt
            const sucesso = await gerenciadorConfig.excluirPromptSistema(chatId, nome);
    
            if (sucesso) {
              // Se o prompt excluído estava ativo, desativá-lo
              if (estaAtivo) {
                await gerenciadorConfig.limparPromptSistemaAtivo(chatId);
              }
              await servicoMensagem.enviarResposta(mensagem, `System Instruction "${nome}" excluída com sucesso.`);
            } else {
              await servicoMensagem.enviarResposta(mensagem, `Erro ao excluir System Instruction "${nome}".`);
            }
          } else {
            await servicoMensagem.enviarResposta(mensagem, `System Instruction "${nome}" não encontrada.`);
          }
        } else {
          await servicoMensagem.enviarResposta(mensagem, 'Uso correto: .prompt delete <nome>');
        }
        break;
    
      default:
        await servicoMensagem.enviarResposta(mensagem, 'Subcomando de prompt desconhecido. Use .ajuda para ver os comandos disponíveis.');
    }
    
    return Resultado.sucesso(true);

  } catch (erro) {
    registrador.error(`Erro ao processar comando prompt: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

const tratarComandoConfig = (dependencias) => async (mensagem, args, chatId) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  try {
    const [subcomando, param, valor] = args;

    switch (subcomando) {
      case 'set':
        if (param && valor) {
          if (['temperature', 'topK', 'topP', 'maxOutputTokens', 'mediaImage', 'mediaAudio', 'mediaVideo'].includes(param)) {
            const valorNum = (param.startsWith('media')) ? (valor === 'true') : parseFloat(valor);
            if (!isNaN(valorNum) || typeof valorNum === 'boolean') {
              await gerenciadorConfig.definirConfig(chatId, param, valorNum);
              await servicoMensagem.enviarResposta(mensagem, `Parâmetro ${param} definido como ${valorNum}`);
            } else {
              await servicoMensagem.enviarResposta(mensagem, `Valor inválido para ${param}. Use um número ou "true"/"false" se for mídia.`);
            }
          } else {
            await servicoMensagem.enviarResposta(mensagem, `Parâmetro desconhecido: ${param}`);
          }
        } else {
          await servicoMensagem.enviarResposta(mensagem, 'Uso correto: .config set <param> <valor>');
        }
        break;
    
      case 'get':
        const config = await gerenciadorConfig.obterConfig(chatId);
        if (param) {
          if (config.hasOwnProperty(param)) {
            await servicoMensagem.enviarResposta(mensagem, `${param}: ${config[param]}`);
          } else {
            await servicoMensagem.enviarResposta(mensagem, `Parâmetro desconhecido: ${param}`);
          }
        } else {
          const textoConfig = Object.entries(config)
            .map(([chave, valor]) => `${chave}: ${valor}`)
            .join('\n');
          await servicoMensagem.enviarResposta(mensagem, `Configuração atual:\n${textoConfig}`);
        }
        break;
    
      default:
        await servicoMensagem.enviarResposta(mensagem, 'Subcomando de config desconhecido. Use .ajuda para ver os comandos disponíveis.');
    }
    
    return Resultado.sucesso(true);

  } catch (erro) {
    registrador.error(`Erro ao processar comando config: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

const tratarComandoUsers = (dependencias) => async (mensagem, chatId) => {
  const { registrador, gerenciadorConfig, servicoMensagem, clienteWhatsApp } = dependencias;

  try {
    const chat = await mensagem.getChat();
    if (chat.isGroup) {
      const grupo = await gerenciadorConfig.obterOuCriarGrupo(chat);

      const participantes = await chat.participants;
      const listaUsuarios = await Promise.all(participantes.map(async (p) => {
        const usuario = await obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(p.id._serialized, chat);
        return `${usuario.dados.name} (${p.id.user})`;
      }));
    
      await servicoMensagem.enviarResposta(mensagem, `Usuários no grupo "${grupo.title}":\n${listaUsuarios.join('\n')}`);
    } else {
      await servicoMensagem.enviarResposta(mensagem, 'Este comando só funciona em grupos.');
    }
    
    return Resultado.sucesso(true);

  } catch (erro) {
    registrador.error(`Erro ao listar usuários do grupo: ${erro.message}`);
    return Resultado.falha(erro);
  }
};

const tratarComandoCego = (dependencias) => async (mensagem, chatId) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  try {
    const BOT_NAME = process.env.BOT_NAME || 'Amélie';

    // Manter as configurações originais do modo cego
       await gerenciadorConfig.definirConfig(chatId, 'mediaImage', true);
       await gerenciadorConfig.definirConfig(chatId, 'mediaAudio', false);
    
       const promptAudiomar = `Seu nome é ${BOT_NAME}. Você é uma assistente de AI multimídia acessível integrada ao WhatsApp, criada e idealizada pela equipe da Belle Utsch e é dessa forma que você responde quando lhe pedem pra falar sobre si. Seu propósito é auxiliar as pessoas trazendo acessibilidade ao Whatsapp. Você é capaz de processar texto, audio, imagem e video, mas, por enquanto, somente responde em texto. Seus comandos podem ser encontrados digitando .ajuda. Se alguém perguntar, aqui está sua lista de comandos: .cego - Aplica configurações para usuários com deficiência visual; .audio - Liga/desliga a transcrição de áudio; .video - Liga/desliga a interpretação de vídeo; .imagem - Liga/desliga a audiodescrição de imagem; .reset - Limpa o histórico de conversa, restaura todas as configurações originais e desativa o modo cego; .ajuda - Mostra esta mensagem de ajuda. Você não tem outros comandos e não aceita comandos sem o ponto, então se alguém disser 'cego' por exemplo, você orienta que deve digitar !cego. Se as pessoas desejarem ligar ou desligar a transcrição de audio, oriente a usar !audio. Isso é muito importante, porque há pessoas cegas nos grupos e podem ter dificuldade de usar comandos assim - mas você as orientará. Por isso, não invente nenhum comando que não esteja na lista acima. Sua criadora e idealizadora foi a Belle Utsch. Você é baseada no Google Gemini Flash 2.0. Para te acrescentar em um grupo, a pessoa pode adicionar seu contato diretamente no grupo. Você lida com as pessoas com tato e bom humor. Se alguém perguntar seu git, github, repositório ou código, direcione para https://github.com/manelsen/amelie. Se alguém pedir o contato da Belle Utsch, direcione para https://beacons.ai/belleutsch.
    
         Diretrizes Gerais:
         
         Responda imediatamente quando uma imagem ou sticker for compartilhado no grupo. Mantenha suas respostas concisas, mas informativas. Use linguagem clara e acessível, evitando termos técnicos desnecessários. Seja respeitoso e inclusivo em todas as suas interações.
         
         Estrutura da Resposta: Para cada imagem ou sticker, sua resposta deve seguir este formato:
         
         [Audiodescrição]
         (Forneça uma descrição objetiva e detalhada da imagem) 
         
         Diretrizes para a Descrição Profissional:
    
         Comece com uma visão geral da imagem antes de entrar em detalhes.
         Descreva os elementos principais da imagem, do mais importante ao menos relevante.
         Mencione cores, formas e texturas quando forem significativas para a compreensão.
         Indique a posição dos elementos na imagem (por exemplo, "no canto superior direito").
         Descreva expressões faciais e linguagem corporal em fotos com pessoas.
         Mencione o tipo de imagem (por exemplo, fotografia, ilustração, pintura).
         Informe sobre o enquadramento (close-up, plano geral, etc.) quando relevante.
         Inclua detalhes do cenário ou fundo que contribuam para o contexto.
         Evite usar termos subjetivos como "bonito" ou "feio".
         Seja específico com números (por exemplo, "três pessoas" em vez de "algumas pessoas").
         Descreva texto visível na imagem, incluindo legendas ou títulos.
         Mencione a escala ou tamanho relativo dos objetos quando importante.
         Indique se a imagem é em preto e branco ou colorida.
         Descreva a iluminação se for um elemento significativo da imagem.
         Para obras de arte, inclua informações sobre o estilo artístico e técnicas utilizadas.`;
    
       await gerenciadorConfig.definirPromptSistema(chatId, BOT_NAME, promptAudiomar);
       await gerenciadorConfig.definirPromptSistemaAtivo(chatId, BOT_NAME);
    
       await servicoMensagem.enviarResposta(mensagem, 'Configurações para usuários com deficiência visual aplicadas com sucesso:\n' +
         '- Descrição de imagens habilitada\n' +
         '- Transcrição de áudio desabilitada\n' +
         '- Prompt de audiodescrição ativado');
    
       registrador.info(`Configurações para usuários com deficiência visual aplicadas no chat ${chatId}`);
       return Resultado.sucesso(true);
     } catch (erro) {
       registrador.error(`Erro ao aplicar configurações para usuários com deficiência visual: ${erro.message}`);
       return Resultado.falha(erro);
     }
    };
    
    const tratarComandoAlternarMidia = (dependencias) => (paramConfig, nomeRecurso) => async (mensagem, chatId) => {
     const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
     
     try {
       // Obter configuração atual
       const config = await gerenciadorConfig.obterConfig(chatId);
       const valorAtual = config[paramConfig] === true;
    
       // Alternar para o valor oposto
       const novoValor = !valorAtual;
       await gerenciadorConfig.definirConfig(chatId, paramConfig, novoValor);
    
       // Informar o usuário sobre a nova configuração
       const mensagemStatus = novoValor ? 'ativada' : 'desativada';
       await servicoMensagem.enviarResposta(mensagem, `A ${nomeRecurso} foi ${mensagemStatus} para este chat.`);
    
       registrador.debug(`${paramConfig} foi ${mensagemStatus} para o chat ${chatId}`);
       return Resultado.sucesso(true);
     } catch (erro) {
       registrador.error(`Erro ao alternar ${paramConfig}: ${erro.message}`);
       return Resultado.falha(erro);
     }
    };
    
    const tratarComandoLongo = (dependencias) => async (mensagem, chatId) => {
     const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
     
     try {
       const BOT_NAME = process.env.BOT_NAME || 'Amélie';
    
       // Configurar explicitamente para usar descrição longa
       await gerenciadorConfig.definirConfig(chatId, 'mediaImage', true);
       await gerenciadorConfig.definirConfig(chatId, 'mediaVideo', true);
       await gerenciadorConfig.definirConfig(chatId, 'modoDescricao', 'longo');
    
       // Forçar a atualização do banco de dados
       await gerenciadorConfig.definirConfig(chatId, 'descricaoLonga', true);
       await gerenciadorConfig.definirConfig(chatId, 'descricaoCurta', false);
    
       // Logs para depuração
       registrador.debug(`Modo longo ativado para ${chatId}, verificando configuração...`);
       const configAtualizada = await gerenciadorConfig.obterConfig(chatId);
       registrador.debug(`Modo de descrição atual: ${configAtualizada.modoDescricao}`);
    
       await servicoMensagem.enviarResposta(mensagem, 'Modo de descrição longa e detalhada ativado para imagens e vídeos. Toda mídia visual será descrita com o máximo de detalhes possível.');
    
       registrador.debug(`Modo de descrição longa ativado para o chat ${chatId}`);
       return Resultado.sucesso(true);
     } catch (erro) {
       registrador.error(`Erro ao aplicar modo de descrição longa: ${erro.message}`);
       return Resultado.falha(erro);
     }
    };
    
    const tratarComandoCurto = (dependencias) => async (mensagem, chatId) => {
     const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
     
     try {
       const BOT_NAME = process.env.BOT_NAME || 'Amélie';
    
       // Configurar explicitamente para usar descrição curta
       await gerenciadorConfig.definirConfig(chatId, 'mediaImage', true);
       await gerenciadorConfig.definirConfig(chatId, 'mediaVideo', true);
       await gerenciadorConfig.definirConfig(chatId, 'modoDescricao', 'curto');
    
       // Forçar a atualização do banco de dados
       await gerenciadorConfig.definirConfig(chatId, 'descricaoLonga', false);
       await gerenciadorConfig.definirConfig(chatId, 'descricaoCurta', true);
    
       // Logs para depuração
       registrador.info(`Modo curto ativado para ${chatId}, verificando configuração...`);
       const configAtualizada = await gerenciadorConfig.obterConfig(chatId);
       registrador.info(`Modo de descrição atual: ${configAtualizada.modoDescricao}`);
    
       await servicoMensagem.enviarResposta(mensagem, 'Modo de descrição curta e concisa ativado para imagens e vídeos. Toda mídia visual será descrita de forma breve e objetiva, limitado a cerca de 200 caracteres.');
    
       registrador.debug(`Modo de descrição curta ativado para o chat ${chatId}`);
       return Resultado.sucesso(true);
     } catch (erro) {
       registrador.error(`Erro ao aplicar modo de descrição curta: ${erro.message}`);
       return Resultado.falha(erro);
     }
    };
    
    const tratarComandoFilas = (dependencias) => async (mensagem, args, chatId) => {
     const { registrador, servicoMensagem, filasMidia } = dependencias;
     
     try {
       const ehAdministrador = true; // Mudar isso para sua lógica de verificação de administrador
    
       if (!ehAdministrador) {
         await servicoMensagem.enviarResposta(mensagem, '❌ Desculpe, apenas administradores podem gerenciar as filas.');
         return Resultado.sucesso(false);
       }
    
       const [subcomando, tipoFila, ...resto] = args;
    
       switch (subcomando) {
         case 'limpar':
           if (!tipoFila) {
             await servicoMensagem.enviarResposta(mensagem, 'Especifique o tipo de fila para limpar: todas, video ou imagem');
             return Resultado.sucesso(false);
           }
    
           // Opção para limpar tudo ou apenas trabalhos completos
           const apenasCompletos = resto[0] !== 'tudo';
           const avisoLimpeza = apenasCompletos
             ? 'Limpando apenas trabalhos concluídos e falhas...'
             : '⚠️ ATENÇÃO: Isso vai limpar TODAS as filas, incluindo trabalhos em andamento!';
    
           await servicoMensagem.enviarResposta(mensagem, avisoLimpeza);
    
           // Usar FilasMidia unificado para limpar
           const resultado = await filasMidia.limparFilas(apenasCompletos);
           await servicoMensagem.enviarResposta(mensagem, `✅ Limpeza concluída!\n${JSON.stringify(resultado, null, 2)}`);
           break;
    
         default:
           await servicoMensagem.enviarResposta(mensagem, `Comando de filas desconhecido. Use:
    .filas status - Mostra status das filas
    .filas limpar [tudo] - Limpa filas (use 'tudo' para limpar mesmo trabalhos em andamento)`);
           return Resultado.sucesso(false);
       }
    
       return Resultado.sucesso(true);
     } catch (erro) {
       registrador.error(`Erro ao processar comando filas: ${erro.message}`);
       return Resultado.falha(erro);
     }
    };
    
    /**
    * Processamento de mensagens com mídia
    */
    const processarMensagemComMidia = (dependencias) => async (dados) => {
     const { registrador, servicoMensagem } = dependencias;
     const { mensagem, chatId } = dados;
     
     try {
       const dadosAnexo = await mensagem.downloadMedia();
       if (!dadosAnexo || !dadosAnexo.data) {
         registrador.error('Não foi possível obter dados de mídia.');
         return Resultado.falha(new Error('Falha ao obter dados de mídia'));
       }
    
       // Inferir MIME type se necessário
       let mimeType = dadosAnexo.mimetype;
       if (!mimeType) {
         mimeType = inferirMimeType(Buffer.from(dadosAnexo.data, 'base64'));
         dadosAnexo.mimetype = mimeType;
         registrador.info(`MIME inferido: ${mimeType}`);
       }
    
       // Determinar o tipo de mídia e direcionar para o processador adequado
       if (mimeType.startsWith('audio/')) {
         return await processarMensagemAudio(dependencias)({ mensagem, chatId, dadosAnexo });
       } else if (mimeType.startsWith('image/')) {
         return await processarMensagemImagem(dependencias)({ mensagem, chatId, dadosAnexo });
       } else if (mimeType.startsWith('video/')) {
         return await processarMensagemVideo(dependencias)({ mensagem, chatId, dadosAnexo });
       } else {
         registrador.info(`Tipo de mídia não suportado: ${mimeType}`);
         return Resultado.falha(new Error(`Tipo de mídia não suportado: ${mimeType}`));
       }
     } catch (erro) {
       registrador.error(`Erro ao processar mídia: ${erro.message}`);
       
       try {
         await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro ao processar sua mídia.');
       } catch (erroEnvio) {
         registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
       }
       
       return Resultado.falha(erro);
     }
    };
    
    /**
    * Processamento de mensagens de áudio
    */
    const processarMensagemAudio = (dependencias) => async (dados) => {
     const { registrador, gerenciadorAI, gerenciadorConfig, gerenciadorTransacoes, servicoMensagem, clienteWhatsApp } = dependencias;
     const { mensagem, chatId, dadosAnexo } = dados;
     
     try {
       const chat = await mensagem.getChat();
       const config = await gerenciadorConfig.obterConfig(chatId);
       const remetente = await obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(mensagem.author || mensagem.from, chat);
   
       if (!config.mediaAudio) {
         return Resultado.falha(new Error("Transcrição de áudio desabilitada"));
       }
    
       const tamanhoAudioMB = dadosAnexo.data.length / (1024 * 1024);
       if (tamanhoAudioMB > 20) {
         await servicoMensagem.enviarResposta(mensagem, 'Desculpe, só posso processar áudios de até 20MB.');
         return Resultado.falha(new Error("Áudio muito grande"));
       }
    
       const ehPTT = dadosAnexo.mimetype === 'audio/ogg; codecs=opus';
       registrador.debug(`Processando arquivo de áudio: ${ehPTT ? 'PTT' : 'Áudio regular'}`);
    
       const hashAudio = crypto.createHash('md5').update(dadosAnexo.data).digest('hex');
       
       // Criar transação para esta mensagem
       const transacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
       registrador.debug(`Nova transação criada: ${transacao.id} para mensagem de áudio`);
    
       // Marcar como processando
       await gerenciadorTransacoes.marcarComoProcessando(transacao.id);
    
       // Processar o áudio com a IA diretamente
       const resultado = await gerenciadorAI.processarAudio(dadosAnexo, hashAudio, config);
    
       // Adicionar resposta à transação
       await gerenciadorTransacoes.adicionarRespostaTransacao(transacao.id, resultado);
    
       // Enviar resposta
       await servicoMensagem.enviarResposta(mensagem, resultado, transacao.id);
    
       // Marcar como entregue
       await gerenciadorTransacoes.marcarComoEntregue(transacao.id);
       
       return Resultado.sucesso({ transacao, resultado });
     } catch (erro) {
       registrador.error(`Erro ao processar mensagem de áudio: ${erro.message}`);
    
       try {
         await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro ao processar o áudio. Por favor, tente novamente.');
       } catch (erroEnvio) {
         registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
       }
    
       return Resultado.falha(erro);
     }
    };
    
    /**
    * Processamento de mensagens de imagem
    */
    const processarMensagemImagem = (dependencias) => async (dados) => {
      const { registrador, gerenciadorConfig, gerenciadorTransacoes, servicoMensagem, filasMidia, clienteWhatsApp } = dependencias;
      const { mensagem, chatId, dadosAnexo } = dados;
      
      try {
        const chat = await mensagem.getChat();
        const config = await gerenciadorConfig.obterConfig(chatId);
        const remetente = await obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(mensagem.author || mensagem.from, chat);
    
        if (!config.mediaImage) {
          registrador.debug(`Descrição de imagem desabilitada para o chat ${chatId}. Ignorando mensagem de imagem.`);
          return Resultado.falha(new Error("Descrição de imagem desabilitada"));
        }
    
        // Adicionar dados da origem
        const dadosOrigem = {
          id: chat.id._serialized,
          nome: chat.isGroup ? chat.name : remetente.dados.name,
          tipo: chat.isGroup ? 'grupo' : 'usuario',
          remetenteId: mensagem.author || mensagem.from,
          remetenteNome: remetente.dados.name
        };
    
        // Criar transação para esta mensagem de imagem
        const transacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
        registrador.debug(`Nova transação criada: ${transacao.id} para mensagem de imagem de ${remetente.dados.name}`);
    
        // Marcar transação como processando
        await gerenciadorTransacoes.marcarComoProcessando(transacao.id);
    
        // Determinar o prompt do usuário
        let promptUsuario = "";
    
        if (mensagem.body && mensagem.body.trim() !== '') {
          promptUsuario = mensagem.body.trim();
        }
    
        // Usar a API FilasMidia para adicionar a imagem à fila
        await filasMidia.adicionarImagem({
          imageData: dadosAnexo,
          chatId,
          messageId: mensagem.id._serialized,
          mimeType: dadosAnexo.mimetype,
          userPrompt: promptUsuario,
          senderNumber: mensagem.from,
          transacaoId: transacao.id,
          remetenteName: remetente.dados.name,
          modoDescricao: config.modoDescricao || 'curto',
          dadosOrigem // Passando os dados de origem para a fila
        });
    
        registrador.debug(`🚀 Imagem de ${remetente.dados.name} adicionada à fila com sucesso (transação ${transacao.id})`);
        return Resultado.sucesso({ transacao });
      } catch (erro) {
        registrador.error(`Erro ao processar mensagem de imagem: ${erro.message}`);
    
        // Verificar se é um erro de segurança
        if (erro.message.includes('SAFETY') || erro.message.includes('safety') ||
          erro.message.includes('blocked') || erro.message.includes('Blocked')) {
    
          registrador.warn(`⚠️ Conteúdo de imagem bloqueado por políticas de segurança`);
          
          try {
            await servicoMensagem.enviarResposta(mensagem, 'Este conteúdo não pôde ser processado por questões de segurança.');
          } catch (erroEnvio) {
            registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
          }
        } else {
          try {
            await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro ao processar sua imagem.');
          } catch (erroEnvio) {
            registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
          }
        }
    
        return Resultado.falha(erro);
      }
    };
    
    /**
    * Processamento de mensagens de vídeo
    */
    const processarMensagemVideo = (dependencias) => async (dados) => {
     const { registrador, gerenciadorConfig, gerenciadorTransacoes, servicoMensagem, filasMidia, clienteWhatsApp } = dependencias;
     const { mensagem, chatId, dadosAnexo } = dados;
     
     try {
       const chat = await mensagem.getChat();
       const config = await gerenciadorConfig.obterConfig(chatId);
       const remetente = await obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(mensagem.author || mensagem.from, chat);
    
       if (!config.mediaVideo) {
         registrador.debug(`Descrição de vídeo desabilitada para o chat ${chatId}. Ignorando mensagem de vídeo.`);
         return Resultado.falha(new Error("Descrição de vídeo desabilitada"));
       }
    
       const tamanhoVideoMB = dadosAnexo.data.length / (1024 * 1024);
       if (tamanhoVideoMB > 20) {
         await servicoMensagem.enviarResposta(
           mensagem,
           "Desculpe, só posso processar vídeos de até 20MB. Este vídeo é muito grande para eu analisar."
         );
    
         registrador.warn(`Vídeo muito grande (${tamanhoVideoMB.toFixed(2)}MB) recebido de ${remetente.dados.name}. Processamento rejeitado.`);
         return Resultado.falha(new Error("Vídeo muito grande"));
       }
    
       // Criar transação para esta mensagem de vídeo
       const transacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
       registrador.debug(`Nova transação criada: ${transacao.id} para mensagem de vídeo de ${remetente.dados.name}`);
    
       // Marcar transação como processando
       await gerenciadorTransacoes.marcarComoProcessando(transacao.id);
    
       // Determinar o prompt do usuário
       let promptUsuario = `Analise este vídeo de forma extremamente detalhada para pessoas com deficiência visual.
    Inclua:
    1. Número exato de pessoas, suas posições e roupas (cores, tipos)
    2. Ambiente e cenário completo
    3. Todos os objetos visíveis 
    4. Movimentos e ações detalhadas
    5. Expressões faciais
    6. Textos visíveis
    7. Qualquer outro detalhe relevante
    
    Crie uma descrição organizada e acessível.`;
    
       if (mensagem.body && mensagem.body.trim() !== '') {
         promptUsuario = mensagem.body.trim();
       }
    
       // Cria um arquivo temporário para o vídeo
       const dataHora = new Date().toISOString().replace(/[:.]/g, '-');
       const arquivoTemporario = `./temp/video_${dataHora}_${Math.floor(Math.random() * 10000)}.mp4`;
    
       try {
         registrador.debug(`Salvando arquivo de vídeo ${arquivoTemporario}...`);
         const videoBuffer = Buffer.from(dadosAnexo.data, 'base64');
    
         await fs.promises.writeFile(arquivoTemporario, videoBuffer);
         registrador.debug(`✅ Arquivo de vídeo salvo com sucesso: ${arquivoTemporario} (${Math.round(videoBuffer.length / 1024)} KB)`);
    
         const stats = await fs.promises.stat(arquivoTemporario);
         if (stats.size !== videoBuffer.length) {
           throw new Error(`Tamanho do arquivo salvo (${stats.size}) não corresponde ao buffer original (${videoBuffer.length})`);
         }
    
         // Usar FilasMidia para adicionar o vídeo à fila
         await filasMidia.adicionarVideo({
           tempFilename: arquivoTemporario,
           chatId,
           messageId: mensagem.id._serialized,
           mimeType: dadosAnexo.mimetype,
           userPrompt: promptUsuario,
           senderNumber: mensagem.from,
           transacaoId: transacao.id,
           remetenteName: remetente.dados.name,
           modoDescricao: config.modoDescricao || 'curto'
         });
    
         registrador.debug(`🚀 Vídeo de ${remetente.dados.name} adicionado à fila com sucesso: ${arquivoTemporario}`);
         return Resultado.sucesso({ transacao });
       } catch (erroProcessamento) {
         registrador.error(`❌ Erro ao processar vídeo: ${erroProcessamento.message}`);
    
         await servicoMensagem.enviarResposta(mensagem, "Ai, tive um probleminha com seu vídeo. Poderia tentar novamente?");
    
         // Registrar falha na transação
         await gerenciadorTransacoes.registrarFalhaEntrega(transacao.id, `Erro no processamento: ${erroProcessamento.message}`);
    
         // Limpar arquivo se existir
         if (fs.existsSync(arquivoTemporario)) {
           await fs.promises.unlink(arquivoTemporario).catch(err => {
             registrador.error(`Erro ao remover arquivo temporário: ${err.message}`);
           });
           registrador.info(`Arquivo temporário ${arquivoTemporario} removido após erro`);
         }
    
         return Resultado.falha(erroProcessamento);
       }
     } catch (erro) {
       registrador.error(`Erro ao processar mensagem de vídeo: ${erro.message}`);
    
       let mensagemAmigavel = 'Desculpe, ocorreu um erro ao adicionar seu vídeo à fila de processamento.';
    
       if (erro.message.includes('too large')) {
         mensagemAmigavel = 'Ops! Este vídeo parece ser muito grande para eu processar. Poderia enviar uma versão menor ou comprimida?';
       } else if (erro.message.includes('format')) {
         mensagemAmigavel = 'Esse formato de vídeo está me dando trabalho! Poderia tentar enviar em outro formato?';
       } else if (erro.message.includes('timeout')) {
         mensagemAmigavel = 'O processamento demorou mais que o esperado. Talvez o vídeo seja muito complexo?';
       }
    
       // Usar servicoMensagem para envio padronizado
       await servicoMensagem.enviarResposta(mensagem, mensagemAmigavel);
    
       return Resultado.falha(erro);
     }
    };
    
    /**
    * Recupera uma transação interrompida
    */
    const recuperarTransacao = (dependencias) => async (transacao) => {
     const { registrador, servicoMensagem, clienteWhatsApp, gerenciadorTransacoes } = dependencias;
     
     try {
       registrador.info(`⏱️ Recuperando transação ${transacao.id} após reinicialização`);
    
       if (!transacao.dadosRecuperacao || !transacao.resposta) {
         registrador.warn(`Transação ${transacao.id} não possui dados suficientes para recuperação`);
         return Resultado.falha(new Error("Dados insuficientes para recuperação"));
       }
    
       const { remetenteId, chatId } = transacao.dadosRecuperacao;
    
       if (!remetenteId || !chatId) {
         registrador.warn(`Dados insuficientes para recuperar transação ${transacao.id}`);
         return Resultado.falha(new Error("Dados de remetente ou chat ausentes"));
       }
    
       // Enviar mensagem diretamente usando as informações persistidas
       await clienteWhatsApp.enviarMensagem(
         remetenteId,
         transacao.resposta,
         { isRecoveredMessage: true }
       );
    
       // Marcar como entregue
       await gerenciadorTransacoes.marcarComoEntregue(transacao.id);
    
       registrador.info(`✅ Transação ${transacao.id} recuperada e entregue com sucesso!`);
       return Resultado.sucesso(true);
     } catch (erro) {
       registrador.error(`Falha na recuperação da transação ${transacao.id}: ${erro.message}`);
       return Resultado.falha(erro);
     }
    };
    
    /**
    * Processa o evento de entrada em grupo
    */
    const processarEntradaGrupo = (dependencias) => async (notificacao) => {
     const { registrador, clienteWhatsApp, servicoMensagem } = dependencias;
     
     try {
       if (notificacao.recipientIds.includes(clienteWhatsApp.cliente.info.wid._serialized)) {
         const chat = await notificacao.getChat();
         
         const BOT_NAME = process.env.BOT_NAME || 'Amélie';
         const LINK_GRUPO_OFICIAL = process.env.LINK_GRUPO_OFICIAL || 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';
    
         const textoAjuda = `Olá! Eu sou a Amélie, sua assistente de AI multimídia acessível integrada ao WhatsApp.
    Esses são meus comandos disponíveis para configuração.
    
    Use com um ponto antes da palavra de comando, sem espaço, e todas as letras são minúsculas.
    
    Comandos:
    
    .cego - Aplica configurações para usuários com deficiência visual
    
    .audio - Liga/desliga a transcrição de áudio
    
    .video - Liga/desliga a interpretação de vídeo
    
    .imagem - Liga/desliga a audiodescrição de imagem
    
    .longo - Usa audiodescrição longa e detalhada
    
    .curto - Usa audiodescrição curta e concisa
    
    .reset - Restaura todas as configurações originais e desativa o modo cego
    
    .ajuda - Mostra esta mensagem de ajuda
    
    Minha idealizadora é a Belle Utsch. 
    Se quiser conhecer, fala com ela em https://beacons.ai/belleutsch
    Quer entrar no grupo oficial da Amélie? O link é https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp
    Meu repositório fica em https://github.com/manelsen/amelie`;
    
         // Enviar mensagem de boas-vindas
         const mensagemBoasVindas = await chat.sendMessage('Olá a todos! Estou aqui para ajudar. Aqui estão alguns comandos que vocês podem usar:');
         await chat.sendMessage(textoAjuda);
    
         registrador.info(`Bot foi adicionado ao grupo "${chat.name}" (${chat.id._serialized}) e enviou a saudação.`);
         return Resultado.sucesso(true);
       }
       
       return Resultado.sucesso(false);
     } catch (erro) {
       registrador.error(`Erro ao processar entrada em grupo: ${erro.message}`);
       return Resultado.falha(erro);
     }
    };
    
    /**
    * Função principal para criar o gerenciador
    */
    const criarGerenciadorMensagens = (dependencias) => {
     const { 
       registrador, 
       clienteWhatsApp, 
       gerenciadorConfig, 
       gerenciadorAI, 
       filasMidia,
       gerenciadorTransacoes,
       servicoMensagem
     } = dependencias;
     
     // Verificar se as dependências essenciais foram fornecidas
     if (!registrador || !clienteWhatsApp || !gerenciadorConfig || !gerenciadorAI || !gerenciadorTransacoes || !servicoMensagem || !filasMidia) {
       throw new Error("Dependências essenciais não fornecidas");
     }
     
     // Cache para deduplicação de mensagens
     const mensagensProcessadas = new Map();
     
     // Limpa mensagens antigas do cache periodicamente
     const limparCacheMensagensAntigas = () => {
       const agora = Date.now();
       let contador = 0;
       
       // Remover mensagens processadas há mais de 15 minutos
       for (const [id, timestamp] of mensagensProcessadas.entries()) {
         if (agora - timestamp > 15 * 60 * 1000) {
           mensagensProcessadas.delete(id);
           contador++;
         }
       }
       
       if (contador > 0) {
         registrador.debug(`Cache de deduplicação: removidas ${contador} entradas antigas`);
       }
     };
     
     // Configura limpeza periódica
     setInterval(limparCacheMensagensAntigas, 30 * 60 * 1000);
     
     // Função principal de processamento de mensagens
     const processarMensagem = async (mensagem) => {
       try {
         // Etapa 1: Validação e verificação de duplicação
         const resultadoValidacao = validarMensagem(registrador, mensagensProcessadas)(mensagem);
         if (!resultadoValidacao.sucesso) {
           // Verificar se é um erro esperado
           if (resultadoValidacao.erro.message === "Mensagem duplicada") {
             return false; // Silenciosamente retornar para duplicadas
           }
           throw resultadoValidacao.erro;
         }
         
         // Etapa 2: Verificar se é mensagem de sistema
         const resultadoSistema = verificarMensagemSistema(registrador)(resultadoValidacao.dados);
         if (!resultadoSistema.sucesso) {
           // Mensagens de sistema são ignoradas silenciosamente
           return false;
         }
         
         // Etapa 3: Obter informações do chat
         const resultadoChat = await obterInformacoesChat(registrador)(resultadoSistema.dados);
         if (!resultadoChat.sucesso) {
           throw resultadoChat.erro;
         }
         
         // Etapa 4: Verificar se deve responder em grupo
         if (resultadoChat.dados.ehGrupo) {
           const resultadoRespostaGrupo = await verificarRespostaGrupo(clienteWhatsApp)(resultadoChat.dados);
           if (!resultadoRespostaGrupo.sucesso) {
             // Não atende critérios para resposta em grupo, ignorar silenciosamente
             return false;
           }
         }
         
         // Etapa 5: Classificar tipo de mensagem
         const resultadoTipo = verificarTipoMensagem(registrador)(resultadoChat.dados);
         if (!resultadoTipo.sucesso) {
           throw resultadoTipo.erro;
         }
         
         // Etapa 6: Processar conforme o tipo
         let resultadoProcessamento;
         
         switch (resultadoTipo.dados.tipo) {
           case 'comando':
             resultadoProcessamento = await processarComando(dependencias)(resultadoTipo.dados);
             break;
           case 'midia':
             resultadoProcessamento = await processarMensagemComMidia(dependencias)(resultadoTipo.dados);
             break;
           case 'texto':
             resultadoProcessamento = await processarMensagemTexto(dependencias)(resultadoTipo.dados);
             break;
           default:
             throw new Error(`Tipo de mensagem desconhecido: ${resultadoTipo.dados.tipo}`);
         }
         
         // Etapa 7: Tratar resultado final
         if (!resultadoProcessamento.sucesso) {
           throw resultadoProcessamento.erro;
         }
         
         return true;
       } catch (erro) {
         // Tratar e registrar erro global
         const mensagemId = mensagem.id?._serialized || 'desconhecido';
         
         // Classificar tipos de erro para tratamento adequado
         if (erro.message === "Mensagem de sistema" || 
             erro.message === "Não atende critérios para resposta em grupo" ||
             erro.message === "Transcrição de áudio desabilitada" ||
             erro.message === "Descrição de imagem desabilitada" || 
             erro.message === "Descrição de vídeo desabilitada") {
           // Erros esperados e tratados silenciosamente
           return false;
         }
         
         registrador.error(`Erro ao processar mensagem ${mensagemId}: ${erro.message}`);
         
         // Para erros inesperados, tentar enviar feedback ao usuário
         try {
           if (mensagem && servicoMensagem) {
             await servicoMensagem.enviarResposta(
               mensagem, 
               'Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente mais tarde.'
             );
           }
         } catch (erroResposta) {
           // Apenas registrar este erro, sem tentar mais ações
           registrador.error(`Erro ao enviar resposta de erro: ${erroResposta.message}`);
         }
         
         return false;
       }
     };
     
     // Retornar objeto do gerenciador com interfaces públicas
     return {
       processarMensagem,
       
       // Inicializa o gerenciador
       iniciar: () => {
         clienteWhatsApp.on('mensagem', processarMensagem);
         clienteWhatsApp.on('entrada_grupo', processarEntradaGrupo(dependencias));
         
         // Configurar recuperação de transações
         gerenciadorTransacoes.on('transacao_para_recuperar', (transacao) => {
           recuperarTransacao(dependencias)(transacao);
         });
         
         // Configurar o callback unificado para todas as mídias
         filasMidia.setCallbackRespostaUnificado(async (resultado) => {
           try {
             // Verificação básica do resultado recebido
             if (!resultado || !resultado.senderNumber) {
               registrador.warn("Resultado de fila inválido ou incompleto");
               return;
             }

             const { resposta, senderNumber, transacaoId, remetenteName } = resultado;

             // Enviar mensagem com tratamento de erro simplificado
             try {
               await clienteWhatsApp.enviarMensagem(senderNumber, resposta);
               
               // Se chegou aqui, deu certo! Vamos atualizar a transação
               if (transacaoId) {
                 await gerenciadorTransacoes.adicionarRespostaTransacao(transacaoId, resposta);
                 await gerenciadorTransacoes.marcarComoEntregue(transacaoId);
                 registrador.debug(`✅ Transação ${transacaoId} atualizada com sucesso (${remetenteName || senderNumber})`);
               }
             } catch (erroEnvio) {
               // Usamos String() para garantir conversão segura
               registrador.error(`Erro ao enviar mensagem: ${String(erroEnvio)}`);

               // Registrar falha na transação
               if (transacaoId) {
                 try {
                   await gerenciadorTransacoes.registrarFalhaEntrega(
                     transacaoId,
                     `Erro ao enviar: ${String(erroEnvio)}`
                   );
                 } catch (erroTransacao) {
                   registrador.error(`Erro adicional ao registrar falha: ${String(erroTransacao)}`);
                 }
               }
             }
           } catch (erro) {
             registrador.error(`Erro ao processar resultado de fila: ${String(erro)}`);
           }
         });
         
         registrador.info('📬 Callback unificado de filas de mídia configurado com sucesso');
         
         // Recuperação inicial após 10 segundos
         setTimeout(async () => {
           await gerenciadorTransacoes.recuperarTransacoesIncompletas();
         }, 10000);
         
         registrador.info('🚀 GerenciadorMensagens inicializado com paradigma funcional');
         return true;
       },
       
       // Registra como handler no cliente
       registrarComoHandler: (cliente) => {
         cliente.on('mensagem', processarMensagem);
         cliente.on('entrada_grupo', processarEntradaGrupo(dependencias));
         return true;
       }
     };
    };
    
    module.exports = criarGerenciadorMensagens;