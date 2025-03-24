/**
 * OperacoesChat - Funções para manipulação de chats e informações de usuário
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');

// Obtém informações do chat
const obterInformacoesChat = _.curry(async (registrador, dados) => {
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
});

// Verifica se deve responder em grupo
const verificarRespostaGrupo = _.curry(async (clienteWhatsApp, dados) => {
  const { mensagem, chat, ehGrupo } = dados;

  // Se não for grupo, sempre processa
  if (!ehGrupo) {
    return Resultado.sucesso({ ...dados, deveResponder: true });
  }

  // Obter o resultado da verificação
  const deveResponder = await clienteWhatsApp.deveResponderNoGrupo(mensagem, chat);
  
  // Retornar falha se não deve responder
  if (!deveResponder) {
    return Resultado.falha(new Error("Não atende critérios para resposta em grupo"));
  }
  
  // Caso contrário, continuar com sucesso
  return Resultado.sucesso({ ...dados, deveResponder: true });
});


// Obter ou criar usuário
const obterOuCriarUsuario = _.curry(async (gerenciadorConfig, clienteWhatsApp, registrador, remetente, chat) => {
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
});

// Verifica se um usuário é administrador do grupo ou se está em chat privado
const verificarPermissaoComando = _.curry(async (mensagem, clienteWhatsApp, registrador) => {
  try {
    const chat = await mensagem.getChat();
    
    const ehGrupo = chat.id && chat.id.server === 'g.us';
    if (!ehGrupo) {
      return Resultado.sucesso(true);
    }

    const remetenteId = mensagem.author || mensagem.from;
    
    if (chat.groupMetadata && chat.groupMetadata.participants) {
      const participante = chat.groupMetadata.participants.find(p => 
        p.id._serialized === remetenteId
      );
      
      if (participante) {
        const ehAdmin = participante.isAdmin || participante.isSuperAdmin;
        return Resultado.sucesso(ehAdmin);
      }
    }
    
    return Resultado.sucesso(false);
  } catch (erro) {
    registrador.error(`Erro na verificação de permissão: ${erro.message}`);
    return Resultado.sucesso(false);
  }
});

module.exports = {
  obterInformacoesChat,
  verificarRespostaGrupo,
  obterOuCriarUsuario,
  verificarPermissaoComando
};