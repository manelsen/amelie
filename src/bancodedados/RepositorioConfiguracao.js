// src/bancodedados/RepositorioConfiguracao.js
/**
 * RepositorioConfiguracao - Repositório específico funcional para configurações
 */

const { criarRepositorioNeDB } = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');

const criarRepositorioConfiguracao = (caminhoBanco, registrador) => {
  const base = criarRepositorioNeDB(caminhoBanco, registrador);

  return {
    ...base,

    /**
     * Obtém configurações para um chat específico
     */
    obterConfigChat: async (idChat, configPadrao = {}) => {
      const resultado = await base.encontrarUm({ chatId: idChat });
      return Resultado.mapear(resultado, dados => {
        return dados ? { ...configPadrao, ...dados } : configPadrao;
      });
    },
    
    /**
     * Define configuração para um chat
     */
    definirConfig: async (idChat, param, valor) => {
      return base.atualizar(
        { chatId: idChat },
        { $set: { [param]: valor } },
        { upsert: true }
      );
    },
    
    /**
     * Reseta as configurações de um chat
     */
    resetarConfig: async (idChat, configPadrao) => {
      return base.atualizar(
        { chatId: idChat },
        { $set: configPadrao },
        { upsert: true }
      );
    },

    /**
     * Obtém configurações para vários chats
     */
    obterConfigsMultiplos: async (idsChat, configPadrao = {}) => {
      const resultado = await base.encontrar({ 
        chatId: { $in: idsChat } 
      });
      
      return Resultado.mapear(resultado, configs => {
        const mapaConfigs = configs.reduce((mapa, config) => {
          mapa[config.chatId] = config;
          return mapa;
        }, {});
        
        return idsChat.reduce((mapa, id) => {
          mapa[id] = mapaConfigs[id] || {...configPadrao};
          return mapa;
        }, {});
      });
    }
  };
};

module.exports = { criarRepositorioConfiguracao };
