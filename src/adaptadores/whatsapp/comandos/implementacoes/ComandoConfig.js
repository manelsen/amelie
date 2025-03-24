/**
 * ComandoConfig - Implementação do comando config
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoConfig = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  // Tratador do subcomando set
  const tratarSet = async (mensagem, args, chatId) => {
    const [param, valor] = args;
    
    if (param && valor) {
      if (['temperature', 'topK', 'topP', 'maxOutputTokens', 'mediaImage', 'mediaAudio', 'mediaVideo'].includes(param)) {
        // Converter valores conforme o tipo
        const valorConvertido = param.startsWith('media') 
          ? valor === 'true'
          : parseFloat(valor);
          
        if (!isNaN(valorConvertido) || typeof valorConvertido === 'boolean') {
          return Trilho.encadear(
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, param, valorConvertido)),
            () => Trilho.dePromise(servicoMensagem.enviarResposta(
              mensagem, 
              `Parâmetro ${param} definido como ${valorConvertido}`
            ))
          )();
        }
        
        return Trilho.dePromise(servicoMensagem.enviarResposta(
          mensagem, 
          `Valor inválido para ${param}. Use um número ou "true"/"false" se for mídia.`
        ));
      }
      
      return Trilho.dePromise(servicoMensagem.enviarResposta(
        mensagem, 
        `Parâmetro desconhecido: ${param}`
      ));
    }
    
    return Trilho.dePromise(servicoMensagem.enviarResposta(
      mensagem, 
      'Uso correto: .config set <param> <valor>'
    ));
  };
  
  // Tratador do subcomando get
  const tratarGet = async (mensagem, args, chatId) => {
    const [param] = args;
    
    return Trilho.encadear(
      () => Trilho.dePromise(gerenciadorConfig.obterConfig(chatId)),
      config => {
        if (param) {
          if (config.hasOwnProperty(param)) {
            return Trilho.dePromise(servicoMensagem.enviarResposta(
              mensagem, 
              `${param}: ${config[param]}`
            ));
          }
          
          return Trilho.dePromise(servicoMensagem.enviarResposta(
            mensagem, 
            `Parâmetro desconhecido: ${param}`
          ));
        }
        
        const textoConfig = Object.entries(config)
          .map(([chave, valor]) => `${chave}: ${valor}`)
          .join('\n');
          
        return Trilho.dePromise(servicoMensagem.enviarResposta(
          mensagem, 
          `Configuração atual:\n${textoConfig}`
        ));
      }
    )();
  };
  
  // Função principal usando pattern matching funcional
  const executar = (mensagem, args, chatId) => {
    const [subcomando, ...restoArgs] = args;
    
    const executarSubcomando = _.cond([
      [_.matches('set'), () => tratarSet(mensagem, restoArgs, chatId)],
      [_.matches('get'), () => tratarGet(mensagem, restoArgs, chatId)],
      [_.stubTrue, () => Trilho.dePromise(servicoMensagem.enviarResposta(
        mensagem, 
        'Subcomando de config desconhecido. Use .ajuda para ver os comandos disponíveis.'
      ))]
    ]);
    
    return executarSubcomando(subcomando?.toLowerCase());
  };
  
  return criarComando(
    '.config', 
    'Gerencia configurações do bot', 
    executar
  );
};

module.exports = criarComandoConfig;