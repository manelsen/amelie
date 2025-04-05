/**
 * RegistroComandos - Registro central de todos os comandos disponíveis
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia'); // Ajuste o caminho se necessário

// Imports de todos os comandos
const criarComandoReset = require('./implementacoes/ComandoReset');
const criarComandoAjuda = require('./implementacoes/ComandoAjuda');
const criarComandoPrompt = require('./implementacoes/ComandoPrompt');
const criarComandoConfig = require('./implementacoes/ComandoConfig');
const criarComandoUsers = require('./implementacoes/ComandoUsers');
const criarComandoCego = require('./implementacoes/ComandoCego');
const criarComandoAudio = require('./implementacoes/ComandoAudio');
const criarComandoVideo = require('./implementacoes/ComandoVideo');
const criarComandoImagem = require('./implementacoes/ComandoImagem');
const criarComandoLongo = require('./implementacoes/ComandoLongo');
const criarComandoCurto = require('./implementacoes/ComandoCurto');
const criarComandoLegenda = require('./implementacoes/ComandoLegenda');
const criarComandoFilas = require('./implementacoes/ComandoFilas');
const criarComandoDoc = require('./implementacoes/ComandoDoc'); // <<< ADICIONADO

/**
 * Cria o registro central de comandos.
 * @param {Object} dependencias - Dependências necessárias (registrador, servicoMensagem, etc.).
 * @returns {Object} Interface pública do registro de comandos.
 */
const criarRegistroComandos = (dependencias) => {
    // Usaremos esta variável para manter a referência ao array final de comandos
    let arrayComandos = [];

    /**
     * Função interna para obter a lista de comandos formatada.
     * Terá acesso ao 'arrayComandos' final via closure.
     * @returns {Array<{nome: string, descricao: string}>} Lista de comandos.
     */
    const obterListaComandos = () => {
        // Mapeia o array *atual* de comandos para a estrutura necessária
        return arrayComandos.map(comando => ({
            nome: comando.nome, // Nome SEM o ponto (baseado na correção anterior)
            descricao: comando.descricao
        }));
    };

    // Adiciona a função getter ao objeto de dependências original
    // para ser passada aos comandos que precisam dela (como ComandoAjuda).
    const dependenciasComFuncaoObterLista = {
        ...dependencias,
        obterListaComandos // Passa a função como dependência
    };

    // --- Criação das Instâncias dos Comandos ---
    // O array 'arrayComandos' é preenchido aqui.
    // Todos os comandos recebem 'dependenciasComFuncaoObterLista'.
    arrayComandos = [
        criarComandoReset(dependenciasComFuncaoObterLista),
        criarComandoAjuda(dependenciasComFuncaoObterLista), // Recebe obterListaComandos
        criarComandoPrompt(dependenciasComFuncaoObterLista),
        criarComandoConfig(dependenciasComFuncaoObterLista),
        criarComandoUsers(dependenciasComFuncaoObterLista),
        criarComandoCego(dependenciasComFuncaoObterLista),
        criarComandoAudio(dependenciasComFuncaoObterLista),
        criarComandoVideo(dependenciasComFuncaoObterLista),
        criarComandoImagem(dependenciasComFuncaoObterLista),
        criarComandoLongo(dependenciasComFuncaoObterLista),
        criarComandoCurto(dependenciasComFuncaoObterLista),
        criarComandoLegenda(dependenciasComFuncaoObterLista),
        criarComandoFilas(dependenciasComFuncaoObterLista),
        criarComandoDoc(dependenciasComFuncaoObterLista) // <<< ADICIONADO
    ];

    // --- Funções Públicas do Registro ---

    /**
     * Retorna a lista pública de comandos formatada.
     * @returns {Array<{nome: string, descricao: string}>} Lista de comandos.
     */
    const listarComandos = () => obterListaComandos();

    /**
     * Encontra um comando registrado pelo seu nome (sem o ponto).
     * @param {string} nomeComando - O nome do comando (ex: 'ajuda').
     * @returns {Object | undefined} O objeto do comando encontrado ou undefined.
     */
    const encontrarComando = nomeComando => {
        // Adiciona verificação para garantir que nomeComando é uma string antes de usar toLowerCase
        if (typeof nomeComando !== 'string') {
            // Se não for string, não pode corresponder a nenhum nome de comando válido
            return undefined;
        }
        const nomeLower = nomeComando.toLowerCase();
        return arrayComandos.find(comando => comando.nome === nomeLower);
    }

    /**
     * Executa um comando encontrado.
     * @param {string} nomeComando - Nome do comando a executar.
     * @param {Object} mensagem - Objeto da mensagem original.
     * @param {Array<string>} args - Argumentos do comando.
     * @param {string} chatId - ID do chat.
     * @returns {Promise<Resultado>} Resultado da execução do comando.
     */
    const executarComando = async (nomeComando, mensagem, args, chatId) => {
        const comando = encontrarComando(nomeComando);

        // Verifica se o comando foi encontrado
        if (!comando) {
            const erroMsg = `Comando desconhecido: ${nomeComando}`;
            dependencias.registrador.warn(erroMsg);
            // Tenta enviar mensagem de erro para o usuário
            try {
                // Garante que servicoMensagem está disponível nas dependências
                if (dependencias.servicoMensagem && typeof dependencias.servicoMensagem.enviarResposta === 'function') {
                    await dependencias.servicoMensagem.enviarResposta(
                        mensagem,
                        `Hmm, não conheço esse comando "${nomeComando}". Use .ajuda para ver os comandos disponíveis!`
                    );
                } else {
                    dependencias.registrador.error("servicoMensagem ou enviarResposta não disponível para enviar erro de comando desconhecido.");
                }
            } catch (err) {
                 dependencias.registrador.error(`Erro ao enviar resposta de comando não encontrado: ${err.message}`);
            }
            return Resultado.falha(new Error(erroMsg));
        }

        // Tenta executar o comando
        try {
            // A execução do comando usará as dependências que ele recebeu na criação
            // (incluindo obterListaComandos, se necessário)
            const resultadoExecucao = await comando.executar(mensagem, args, chatId);
            // Se a execução não retornar um Resultado explícito (pode acontecer em comandos mais simples),
            // consideramos sucesso, mas logamos para garantir.
             if (!resultadoExecucao || typeof resultadoExecucao.sucesso === 'undefined') {
                 return Resultado.sucesso(true); // Assume sucesso
             }
            return resultadoExecucao; // Retorna o Resultado da execução
        } catch(erroExecucao) {
             dependencias.registrador.error(`Erro durante a execução do comando '${nomeComando}': ${erroExecucao.message}`, erroExecucao);
             // Tenta notificar o usuário sobre o erro na execução
             try {
                 // Garante que servicoMensagem está disponível
                 if (dependencias.servicoMensagem && typeof dependencias.servicoMensagem.enviarResposta === 'function') {
                     await dependencias.servicoMensagem.enviarResposta(
                         mensagem,
                         `Eita! Encontrei um probleminha ao processar o comando .${nomeComando}. Pode tentar de novo?`
                     );
                 } else {
                    dependencias.registrador.error("servicoMensagem ou enviarResposta não disponível para enviar erro de execução.");
                 }
             } catch(err) {
                 dependencias.registrador.error(`Erro ao enviar mensagem de erro de execução do comando '${nomeComando}': ${err.message}`);
             }
             return Resultado.falha(erroExecucao); // Retorna a falha
        }
    };

    /**
     * Verifica se um comando com o nome especificado existe no registro.
     * @param {string} nomeComando - Nome do comando (sem o ponto).
     * @returns {boolean} Verdadeiro se o comando existe.
     */
    const comandoExiste = (nomeComando) => {
        // Compara o nome fornecido (em minúsculas) com os nomes registrados
        return arrayComandos.some(comando => comando.nome === nomeComando.toLowerCase());
    };

    // --- Interface Pública do Registro ---
    // Retorna um objeto imutável com as funções públicas
    return Object.freeze({
        encontrarComando,
        executarComando,
        listarComandos, // Expõe a função que busca a lista atualizada
        comandoExiste,
        comandos: arrayComandos // Expõe o array final de comandos (para referência, se necessário)
    });
};

module.exports = criarRegistroComandos;