// src/config/ConfigManager.js
const path = require('path');
const { Resultado } = require('../bancodedados/Repositorio');
const { criarFabricaRepositorio } = require('../bancodedados/FabricaRepositorio');

/**
 * Fábrica para o ConfigManager funcional
 */
const criarConfigManager = (registrador, diretorioDB = path.join(process.cwd(), 'db')) => {
  const fabricaRepositorio = criarFabricaRepositorio(registrador, diretorioDB);
  const repoConfig = fabricaRepositorio.obterRepositorioConfiguracao();
  const repoPrompts = fabricaRepositorio.obterRepositorioPrompts();
  const repoGrupos = fabricaRepositorio.obterRepositorioGrupos();
  const repoUsuarios = fabricaRepositorio.obterRepositorioUsuarios();
  
  const configPadrao = {
    temperature: 0.9,
    topK: 1,
    topP: 0.95,
    maxOutputTokens: 1024,
    mediaImage: true,  
    mediaAudio: false,  
    mediaVideo: true,
    modoDescricao: 'curto'
  };

  /**
   * Obtém um prompt de sistema pelo nome
   */
  const obterPromptSistema = async (chatId, nome) => {
    const resultado = await repoPrompts.obterPrompt(chatId, nome);
    return Resultado.dobrar(resultado, (p) => p, (e) => {
      registrador.error(`Erro ao obter prompt: ${e.message}`);
      return Resultado.falha(e);
    });
  };

  /**
   * Define configuração para um chat
   */
  const definirConfig = async (chatId, param, valor) => {
    const resultado = await repoConfig.definirConfig(chatId, param, valor);
    return Resultado.dobrar(resultado, () => true, (e) => {
      registrador.error(`Erro ao definir configuração: ${e.message}`);
      return Resultado.falha(e);
    });
  };

  return {
    definirConfig,

    obterConfig: async (chatId) => {
      const resultado = await repoConfig.obterConfigChat(chatId, configPadrao);
      
      return Resultado.dobrar(
        resultado,
        async (config) => {
          if (config.usarLegenda === true) config.modoDescricao = 'legenda';
          
          if (config.activePrompt) {
            const promptAtivo = await obterPromptSistema(chatId, config.activePrompt);
            if (promptAtivo && !promptAtivo.sucesso === false) { // Verifica se não é Resultado.falha
              config.systemInstructions = promptAtivo.text;
              const match = config.systemInstructions.match(/^Seu nome é (\w+)\./);
              config.botName = match ? match[1] : process.env.BOT_NAME || 'Amélie';
            }
          } else {
            config.botName = process.env.BOT_NAME || 'Amélie';
          }
    
          if (config.systemInstructions && typeof config.systemInstructions !== 'string') {
            config.systemInstructions = String(config.systemInstructions);
          }
    
          return config;
        },
        (erro) => {
          registrador.error(`Erro ao obter configuração: ${erro.message}`);
          return Resultado.falha(erro);
        }
      );
    },

    resetarConfig: async (chatId) => {
      const configReset = {
        ...configPadrao,
        modoDescricao: 'curto',
        descricaoLonga: false,
        descricaoCurta: true,
        activePrompt: null
      };
      const resultado = await repoConfig.resetarConfig(chatId, configReset);
      return Resultado.dobrar(resultado, () => {
        registrador.info(`Configurações resetadas para ${chatId}`);
        return true;
      }, (erro) => {
        registrador.error(`Erro ao resetar configuração: ${erro.message}`);
        return Resultado.falha(erro);
      });
    },

    definirPromptSistema: async (chatId, nome, texto) => {
      const resultado = await repoPrompts.definirPrompt(chatId, nome, texto);
      return Resultado.dobrar(resultado, () => true, (e) => {
        registrador.error(`Erro ao definir prompt: ${e.message}`);
        return Resultado.falha(e);
      });
    },

    obterPromptSistema,

    listarPromptsSistema: async (chatId) => {
      const resultado = await repoPrompts.listarPrompts(chatId);
      return Resultado.dobrar(resultado, (p) => p, (e) => {
        registrador.error(`Erro ao listar prompts: ${e.message}`);
        return Resultado.falha(e);
      });
    },

    definirPromptSistemaAtivo: async (chatId, nomePrompt) => {
      try {
        const prompt = await obterPromptSistema(chatId, nomePrompt);
        if (prompt && !prompt.sucesso === false) {
          await definirConfig(chatId, 'activePrompt', nomePrompt);
          return true;
        }
        registrador.warn(`Prompt ${nomePrompt} não encontrado para ${chatId}`);
        return false;
      } catch (erro) {
        registrador.error(`Erro ao definir prompt ativo: ${erro.message}`);
        return false;
      }
    },

    limparPromptSistemaAtivo: async (chatId) => {
      try {
        await definirConfig(chatId, 'activePrompt', null);
        return true;
      } catch (erro) {
        registrador.error(`Erro ao limpar prompt ativo: ${erro.message}`);
        return false;
      }
    },

    excluirPromptSistema: async (chatId, nome) => {
      const resultado = await repoPrompts.excluirPrompt(chatId, nome);
      return Resultado.dobrar(resultado, (sucesso) => {
        if (sucesso) {
          registrador.info(`Prompt ${nome} excluído para ${chatId}`);
          return true;
        }
        registrador.warn(`Prompt ${nome} não encontrado para exclusão`);
        return false;
      }, (erro) => {
        registrador.error(`Erro ao excluir prompt: ${erro.message}`);
        return Resultado.falha(erro);
      });
    },

    obterOuCriarGrupo: async (chat) => {
      const resultado = await repoGrupos.obterOuCriarGrupo(chat.id._serialized, { nome: chat.name });
      return Resultado.dobrar(resultado, (g) => g, (e) => {
        registrador.error(`Erro ao processar grupo: ${e.message}`);
        return Resultado.falha(e);
      });
    },

    obterOuCriarUsuario: async (remetente) => {
      const resultado = await repoUsuarios.obterOuCriarUsuario(remetente.id._serialized, { nome: remetente.pushname });
      return Resultado.dobrar(resultado, (u) => u, (e) => {
        registrador.error(`Erro ao processar usuário: ${e.message}`);
        return Resultado.falha(e);
      });
    }
  };
};

module.exports = { criarConfigManager };
