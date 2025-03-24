/**
 * ComandoAjuda - Implementação do comando ajuda
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoAjuda = (dependencias) => {
  const { servicoMensagem, registroComandos } = dependencias;
  
  const executar = (mensagem, args, chatId) => {
    const BOT_NAME = process.env.BOT_NAME || 'Amélie';
    const LINK_GRUPO_OFICIAL = process.env.LINK_GRUPO_OFICIAL || 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';

    // Obter comandos do registro
    const comandos = registroComandos.listarComandos();
    const listaComandos = comandos
      .map(cmd => `.${cmd.nome} - ${cmd.descricao}`)
      .join('\n\n');

    const textoAjuda = `Olá! Eu sou a Amélie, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Esses são meus comandos disponíveis para configuração.

Use com um ponto antes da palavra de comando, sem espaço, e todas as letras são minúsculas.

Comandos:

${listaComandos}

Minha idealizadora é a Belle Utsch. 
Se quiser conhecer, fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da Amélie? O link é ${LINK_GRUPO_OFICIAL}
Meu repositório fica em https://github.com/manelsen/amelie`;

    return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, textoAjuda));
  };
  
  return criarComando(
    '.ajuda', 
    'Mostra esta mensagem de ajuda',
    executar
  );
};

module.exports = criarComandoAjuda;