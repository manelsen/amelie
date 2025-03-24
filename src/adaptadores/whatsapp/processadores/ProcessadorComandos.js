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

    // Extrair comando e argumentos
    const [comando, ...args] = mensagem.body.slice(1).split(' ');
    registrador.debug(`Processando comando: ${comando}, Argumentos: ${args.join(' ')}`);

    // Verificar permissões usando pipe funcional
    return Trilho.encadear(
      // Verificar permissões
      () => verificarPermissaoComando(mensagem, clienteWhatsApp, registrador),
      
      // Executar comando se tiver permissão
      resultado => {
        if (!resultado.dados) {
          return Trilho.dePromise(
            servicoMensagem.enviarResposta(
              mensagem,
              'Desculpe, apenas administradores do grupo podem executar comandos.'
            )
          ).then(() => Resultado.falha(new Error("Usuário sem permissão para executar comandos")));
        }
        
        return registroComandos.executarComando(comando.toLowerCase(), mensagem, args, chatId);
      }
    )();
  };

  return { processarComando };
};

module.exports = criarProcessadorComandos;