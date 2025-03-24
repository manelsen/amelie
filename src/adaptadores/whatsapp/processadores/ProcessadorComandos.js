/**
 * ProcessadorComandos - Processamento de mensagens de comando
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const { verificarPermissaoComando } = require('../dominio/OperacoesChat');

const criarProcessadorComandos = (dependencias) => {
  const { registrador, servicoMensagem, clienteWhatsApp, registroComandos } = dependencias;

  const processarComando = async (dados) => {
    const { mensagem, chatId } = dados;
  
    try {
      // Extrair comando e argumentos
      const [comando, ...args] = mensagem.body.slice(1).split(' ');
      registrador.debug(`Processando comando: ${comando}, Argumentos: ${args.join(' ')}`);
  
      // Verificação crítica para registroComandos
      if (!registroComandos || typeof registroComandos.executarComando !== 'function') {
        registrador.error("Sistema de comandos não inicializado corretamente!");
        
        // Mensagem amigável para o usuário
        await servicoMensagem.enviarResposta(
          mensagem,
          'Ops! Nosso sistema de comandos está tirando uma sonequinha agora. Tente novamente daqui a pouquinho! 😴'
        );
        
        return Resultado.falha(new Error("registroComandos não inicializado"));
      }
  
      // Verificar permissões de forma direta
      const chat = await mensagem.getChat();
      
      // Por padrão, permitir em chats privados
      let temPermissao = true;
      
      // Se for grupo, verificar se é admin
      const ehGrupo = chat.id && chat.id.server === 'g.us';
      if (ehGrupo) {
        const remetenteId = mensagem.author || mensagem.from;
        
        if (chat.groupMetadata && chat.groupMetadata.participants) {
          const participante = chat.groupMetadata.participants.find(p => 
            p.id._serialized === remetenteId
          );
          
          if (participante) {
            temPermissao = participante.isAdmin || participante.isSuperAdmin;
          } else {
            temPermissao = false;
          }
        }
      }
      
      // Se não tiver permissão, enviar mensagem e retornar erro
      if (!temPermissao) {
        await servicoMensagem.enviarResposta(
          mensagem,
          'Desculpe, apenas administradores do grupo podem executar comandos.'
        );
        return Resultado.falha(new Error("Usuário sem permissão para executar comandos"));
      }
      
      // Verificar se o comando existe antes de executá-lo
      if (!registroComandos.comandoExiste(comando.toLowerCase())) {
        await servicoMensagem.enviarResposta(
          mensagem,
          `Hmm, não conheço esse comando "${comando}". Use .ajuda para ver os comandos disponíveis!`
        );
        return Resultado.falha(new Error(`Comando desconhecido: ${comando}`));
      }
      
      // Executar comando
      return await registroComandos.executarComando(comando.toLowerCase(), mensagem, args, chatId);
      
    } catch (erro) {
      registrador.error(`Erro ao processar comando: ${erro.message}`);
      
      try {
        await servicoMensagem.enviarResposta(
          mensagem,
          'Eita! Encontrei um probleminha ao processar seu comando. Pode tentar de novo?'
        );
      } catch (erroEnvio) {
        registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
      }
      
      return Resultado.falha(erro);
    }
  };

  return { processarComando };
};

module.exports = criarProcessadorComandos;