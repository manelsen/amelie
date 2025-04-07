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
    // await chat.sendSeen(); // Removido permanentemente - causava problemas em alguns grupos

    const chatId = chat.id._serialized;
    const ehGrupo = chatId.endsWith('@g.us');

    return Resultado.sucesso({
      ...dados,
      chat,
      chatId,
      ehGrupo
    });
  } catch (erro) {
    // Usar ID da mensagem e chat inicial para log de erro, caso 'chat' não seja obtido
    const msgId = dados?.mensagem?.id?._serialized || 'ID Indisponível';
    const initialChatId = dados?.mensagem?.from || 'Chat Indisponível';
    registrador.error(`[ObterInfoChat][${initialChatId}][${msgId}] Erro ao obter informações do chat: ${erro.message}`, erro);
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
const obterOuCriarUsuario = _.curry(async (gerenciadorConfig, clienteWhatsApp, registrador, remetenteIdSerializado, chat) => { // Mudança: Recebe remetenteIdSerializado
  try {
    // Se temos gerenciadorConfig, usar o método dele
    if (gerenciadorConfig) {
      // Busca o contato para obter o nome atualizado, se possível
      let nomeUsuario = `Usuário${remetenteIdSerializado.substring(0, 6).replace(/[^0-9]/g, '')}`; // Nome padrão
      try {
        const contato = await clienteWhatsApp.cliente.getContactById(remetenteIdSerializado);
        if (contato && (contato.pushname || contato.name || contato.shortName)) {
           nomeUsuario = contato.pushname || contato.name || contato.shortName;
        }
      } catch (erroContato) {
         registrador.warn(`Não foi possível obter detalhes do contato ${remetenteIdSerializado} para obter nome: ${erroContato.message}`);
      }

      // Chama o método refatorado do gerenciadorConfig
      const resultadoUsuario = await gerenciadorConfig.obterOuCriarUsuario(remetenteIdSerializado, { nome: nomeUsuario });

      // O tratamento de nome padrão agora deve ser feito dentro de obterOuCriarUsuario do ConfigManager ou no Repositorio
      // Mas mantemos a verificação aqui por segurança, caso o retorno ainda seja problemático
      if (resultadoUsuario.sucesso && (!resultadoUsuario.dados.name || resultadoUsuario.dados.name === 'undefined')) {
         resultadoUsuario.dados.name = nomeUsuario; // Usa o nome obtido ou o padrão gerado
      }

      return resultadoUsuario; // Retorna o Resultado diretamente
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
