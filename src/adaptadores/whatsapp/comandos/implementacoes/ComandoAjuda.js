// src/adaptadores/whatsapp/comandos/implementacoes/ComandoAjuda.js

/**
 * ComandoAjuda - Implementação do comando ajuda
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia'); // Ajuste o caminho se necessário
const { criarComando } = require('../ComandoBase'); // 

/**
 * Cria a instância do comando de ajuda.
 * @param {Object} dependencias - Dependências injetadas.
 * @param {Object} dependencias.servicoMensagem - Serviço para enviar mensagens.
 * @param {Function} dependencias.obterListaComandos - Função para obter a lista de comandos dinamicamente.
 * @param {Object} dependencias.registrador - Logger para registrar informações e erros.
 * @returns {Object} Instância do comando de ajuda.
 */
const criarComandoAjuda = (dependencias) => {
    // Recebe 'obterListaComandos' em vez de 'registroComandos' diretamente
    const { servicoMensagem, obterListaComandos, registrador } = dependencias;

    /**
     * Função de execução do comando ajuda.
     * @param {Object} mensagem - Objeto da mensagem original.
     * @param {Array<string>} args - Argumentos do comando (não utilizados aqui).
     * @param {string} chatId - ID do chat.
     * @returns {Promise<Resultado>} Resultado da operação de envio.
     */
    const executar = async (mensagem, args, chatId) => { // Marcado como async
        const NOME_BOT = process.env.BOT_NAME || 'Amélie';
        const LINK_GRUPO_OFICIAL = process.env.LINK_GRUPO_OFICIAL || 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';

        let comandos = [];
        try {
            // Verifica se a função foi passada corretamente antes de chamar
            if (typeof obterListaComandos === 'function') {
                 // Chama a função para obter a lista de comandos NO MOMENTO DA EXECUÇÃO
                 comandos = obterListaComandos();
            } else {
                 // Log de erro importante se a função estiver faltando
                 registrador.error("Erro Crítico: A função 'obterListaComandos' não foi injetada corretamente em ComandoAjuda.");
                 // Envia uma mensagem de erro para o usuário indicando uma falha interna
                 await servicoMensagem.enviarResposta(mensagem, "Desculpe, ocorreu um erro interno ao tentar buscar a lista de comandos. Por favor, avise um administrador.");
                 return Resultado.falha("Dependência 'obterListaComandos' ausente ou inválida.");
            }
        } catch (erro) {
             // Captura erros que podem ocorrer dentro de obterListaComandos
             registrador.error(`Erro ao chamar obterListaComandos em ComandoAjuda: ${erro.message}`, erro);
             await servicoMensagem.enviarResposta(mensagem, "Desculpe, ocorreu um erro ao buscar a lista de comandos.");
             return Resultado.falha(erro);
        }


        // Adiciona o '.' de volta apenas para exibição na ajuda
        // Garante que mesmo se 'comandos' for vazio, não quebre
        const listaComandos = (comandos || [])
            .map(cmd => `.${cmd.nome} - ${cmd.descricao}`) // Adiciona o '.' para exibição
            .join('\n\n');

        // Monta o texto de ajuda completo
        const textoAjuda = `Olá! Eu sou a ${NOME_BOT}, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Esses são meus comandos disponíveis para configuração.

Use com um ponto antes da palavra de comando, sem espaço, e todas as letras são minúsculas.
Comandos:

${listaComandos || '*Nenhum comando disponível no momento.*'}

Minha idealizadora é a Belle Utsch.
Se quiser conhecer, fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da Amélie?
O link é ${LINK_GRUPO_OFICIAL}
Meu repositório fica em https://github.com/manelsen/amelie`;

        // Envia a resposta usando o serviço de mensagem e o padrão Trilho
        return await Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, textoAjuda));
    };

    // Cria e retorna o objeto de comando usando a fábrica base
    return criarComando(
        'ajuda',
        'Mostra esta mensagem de ajuda',
        executar
    ); //
};

module.exports = criarComandoAjuda;