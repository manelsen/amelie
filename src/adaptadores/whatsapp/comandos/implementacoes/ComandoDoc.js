/**
 * ComandoDoc - Implementação do comando doc para ativar/desativar processamento de documentos
 */
const { Resultado } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoDoc = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  const executar = async (mensagem, args, chatId) => { // Marcar como async
    
    let configAntes; // Variável para guardar a config lida inicialmente
    let novoValor; // Variável para guardar o valor que tentamos definir

    try {
      // 1. Obter configuração atual
      
      configAntes = await gerenciadorConfig.obterConfig(chatId);
      if (!configAntes) {
           registrador.error(`[CmdDoc] Falha ao obter config inicial.`);
           throw new Error("Configuração não encontrada");
      }
      // Assume 'false' se a chave não existir ainda
      const valorAtual = configAntes.mediaDocumento === true;
      

      // 2. Calcular e tentar definir o novo valor
      novoValor = !valorAtual; // Guardar o valor que vamos tentar definir
      

      // *** Chamada para definir a configuração ***
      const setResult = await gerenciadorConfig.definirConfig(chatId, 'mediaDocumento', novoValor);

      // *** LOG IMPORTANTE: Verificar o resultado da operação de escrita ***
      
      // Se definirConfig retornar explicitamente false em caso de falha sem erro:
      // if (setResult === false) {
      //      registrador.error(`[CmdDoc] gerenciadorConfig.definirConfig retornou falha.`);
      //      throw new Error("Falha silenciosa ao salvar configuração de documento");
      // }

      

      // 3. *** VERIFICAÇÃO: Re-ler a configuração para confirmar a escrita ***
      
      const configApos = await gerenciadorConfig.obterConfig(chatId);
      if (!configApos) {
           registrador.error(`[CmdDoc] Falha ao obter config APÓS tentativa de escrita.`);
      } else if (configApos.mediaDocumento !== novoValor) {
           registrador.error(`[CmdDoc] *** VERIFICAÇÃO FALHOU! mediaDocumento no DB é ${configApos.mediaDocumento}, mas deveria ser ${novoValor} ***`);
           // throw new Error("Falha ao confirmar a escrita da configuração de documento no DB");
      } else {
           
      }

      // 4. Informar o usuário sobre a nova configuração (baseado no 'novoValor' calculado)
      const mensagemStatus = novoValor ? 'ativado' : 'desativado';
      const feedbackMsg = `📄 O processamento de documentos foi ${mensagemStatus} para este chat.`;

      // *** Adicionar log INFO antes de tentar enviar ***
      
      await servicoMensagem.enviarResposta(mensagem, feedbackMsg);
      

      return Resultado.sucesso(true); // Indicar sucesso da execução do comando

    } catch (erro) {
      // Logar o valor que foi lido e o que se tentou definir pode ajudar
      registrador.error(`[CmdDoc] Erro ao executar (Lido: ${configAntes?.mediaDocumento}, Tentado: ${novoValor}): ${erro.message}`, erro);
      // Tentar enviar mensagem de erro genérica
      try {
        await servicoMensagem.enviarResposta(mensagem, 'Ops! Ocorreu um erro ao tentar alterar a configuração de documentos.');
      } catch (erroEnvio) {
        registrador.error(`[CmdDoc] Falha ao enviar mensagem de erro: ${erroEnvio.message}`);
      }
      return Resultado.falha(erro); // Indicar falha
    }
  };

  return criarComando(
    'doc',
    'Liga/desliga o processamento de documentos',
    executar
  );
};

module.exports = criarComandoDoc;