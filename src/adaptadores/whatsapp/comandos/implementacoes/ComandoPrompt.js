/**
 * ComandoPrompt - Implementação do comando prompt
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoPrompt = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  // Tratadores específicos para cada subcomando
  const tratarSet = async (mensagem, args, chatId) => {
    const [nome, ...resto] = args;
    
    if (nome && resto.length > 0) {
      const textoPrompt = resto.join(' ');
      
      return Trilho.encadear(
        () => Trilho.dePromise(gerenciadorConfig.definirPromptSistema(chatId, nome, textoPrompt)),
        () => Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
            `System Instruction "${nome}" definida com sucesso.`))
      )();
    } 
    
    return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
        'Uso correto: .prompt set <nome> <texto>'));
  };
  
  const tratarGet = async (mensagem, args, chatId) => {
    const [nome] = args;
    
    if (nome) {
      return Trilho.encadear(
        () => Trilho.dePromise(gerenciadorConfig.obterPromptSistema(chatId, nome)),
        prompt => {
          if (prompt) {
            return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
                `System Instruction "${nome}":\n${prompt.text}`));
          }
          return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
              `System Instruction "${nome}" não encontrada.`));
        }
      )();
    }
    
    return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
        'Uso correto: .prompt get <nome>'));
  };
  
  const tratarList = async (mensagem, chatId) => {
    return Trilho.encadear(
      () => Trilho.dePromise(gerenciadorConfig.listarPromptsSistema(chatId)),
      prompts => {
        if (prompts.length > 0) {
          const listaPrompts = prompts.map(p => p.name).join(', ');
          return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
              `System Instructions disponíveis: ${listaPrompts}`));
        }
        return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
            'Nenhuma System Instruction definida.'));
      }
    )();
  };
  
  const tratarUse = async (mensagem, args, chatId) => {
    const [nome] = args;
    
    if (nome) {
      return Trilho.encadear(
        () => Trilho.dePromise(gerenciadorConfig.obterPromptSistema(chatId, nome)),
        prompt => {
          if (prompt) {
            return Trilho.encadear(
              () => Trilho.dePromise(gerenciadorConfig.definirPromptSistemaAtivo(chatId, nome)),
              () => Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
                  `System Instruction "${nome}" ativada para este chat.`))
            )();
          }
          return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
              `System Instruction "${nome}" não encontrada.`));
        }
      )();
    }
    
    return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
        'Uso correto: .prompt use <nome>'));
  };
  
  const tratarClear = async (mensagem, chatId) => {
    return Trilho.encadear(
      () => Trilho.dePromise(gerenciadorConfig.limparPromptSistemaAtivo(chatId)),
      () => Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
          'System Instruction removida. Usando o modelo padrão.'))
    )();
  };
  
  const tratarDelete = async (mensagem, args, chatId) => {
    const [nome] = args;
    
    if (nome) {
      return Trilho.encadear(
        // Verificar se o prompt existe
        () => Trilho.dePromise(gerenciadorConfig.obterPromptSistema(chatId, nome)),
        promptExiste => {
          if (!promptExiste) {
            return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
                `System Instruction "${nome}" não encontrada.`));
          }
          
          // Verificar se está ativo
          return Trilho.encadear(
            () => Trilho.dePromise(gerenciadorConfig.obterConfig(chatId)),
            config => {
              const estaAtivo = config.activePrompt === nome;
              
              // Excluir o prompt
              return Trilho.encadear(
                () => Trilho.dePromise(gerenciadorConfig.excluirPromptSistema(chatId, nome)),
                sucesso => {
                  if (sucesso) {
                    // Se estava ativo, desativar
                    return Trilho.encadear(
                      () => estaAtivo ? 
                          Trilho.dePromise(gerenciadorConfig.limparPromptSistemaAtivo(chatId)) : 
                          Resultado.sucesso(true),
                      () => Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
                          `System Instruction "${nome}" excluída com sucesso.`))
                    )();
                  }
                  
                  return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
                      `Erro ao excluir System Instruction "${nome}".`));
                }
              )();
            }
          )();
        }
      )();
    }
    
    return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
        'Uso correto: .prompt delete <nome>'));
  };
  
  // Função principal de execução com pattern matching funcional
  const executar = (mensagem, args, chatId) => {
    const [subcomando, ...restoArgs] = args;
    
    // Pattern matching funcional com cond
    const executarSubcomando = _.cond([
      [_.matches('set'), () => tratarSet(mensagem, restoArgs, chatId)],
      [_.matches('get'), () => tratarGet(mensagem, restoArgs, chatId)],
      [_.matches('list'), () => tratarList(mensagem, chatId)],
      [_.matches('use'), () => tratarUse(mensagem, restoArgs, chatId)],
      [_.matches('clear'), () => tratarClear(mensagem, chatId)],
      [_.matches('delete'), () => tratarDelete(mensagem, restoArgs, chatId)],
      [_.stubTrue, () => Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, 
          'Subcomando de prompt desconhecido. Use .ajuda para ver os comandos disponíveis.'))]
    ]);
    
    return executarSubcomando(subcomando?.toLowerCase());
  };
  
  return criarComando(
    '.prompt', 
    'Gerencia instruções do sistema para personalização', 
    executar
  );
};

module.exports = criarComandoPrompt;