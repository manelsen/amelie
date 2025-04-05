// src/config/ConfigManager.js
const path = require('path');
const { Resultado } = require('../bancodedados/Repositorio');

class ConfigManager {
  constructor(registrador, diretorioDB = path.join(process.cwd(), 'db')) {
    this.registrador = registrador;
    this.diretorioDB = diretorioDB;
    
    // Usando a nova arquitetura internamente
    const FabricaRepositorio = require('../bancodedados/FabricaRepositorio');
    this.fabricaRepositorio = new FabricaRepositorio(registrador, diretorioDB);
    this.repoConfig = this.fabricaRepositorio.obterRepositorioConfiguracao();
    this.repoPrompts = this.fabricaRepositorio.obterRepositorioPrompts();
    this.repoGrupos = this.fabricaRepositorio.obterRepositorioGrupos();
    this.repoUsuarios = this.fabricaRepositorio.obterRepositorioUsuarios();
    
    // Configuração padrão
    this.configPadrao = {
      temperature: 0.9,
      topK: 1,
      topP: 0.95,
      maxOutputTokens: 1024,
      mediaImage: true,  
      mediaAudio: false,  
      mediaVideo: true,
      modoDescricao: 'curto'
    };
    
  }

  async definirConfig(chatId, param, valor) {
    const resultado = await this.repoConfig.definirConfig(chatId, param, valor);
    
    return Resultado.dobrar(
      resultado,
      () => {
        
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao definir configuração: ${erro.message}`);
        throw erro;
      }
    );
  }

  async obterConfig(chatId) {
    const resultado = await this.repoConfig.obterConfigChat(chatId, this.configPadrao);
    
    return Resultado.dobrar(
      resultado,
      async (config) => {
        // Verificação explícita para legenda
        if (config.usarLegenda === true) {
          
          config.modoDescricao = 'legenda';
        }
        
        // Resto do código original
        if (config.activePrompt) {
          const promptAtivo = await this.obterPromptSistema(chatId, config.activePrompt);
          if (promptAtivo) {
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
        this.registrador.error(`Erro ao obter configuração: ${erro.message}`);
        throw erro;
      }
    );
  }

  async resetarConfig(chatId) {
    const configReset = {
      ...this.configPadrao,
      modoDescricao: 'curto',
      descricaoLonga: false,
      descricaoCurta: true,
      activePrompt: null
    };
    
    const resultado = await this.repoConfig.resetarConfig(chatId, configReset);
    
    return Resultado.dobrar(
      resultado,
      () => {
        this.registrador.info(`Configurações resetadas para ${chatId}`);
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao resetar configuração: ${erro.message}`);
        throw erro;
      }
    );
  }

  async definirPromptSistema(chatId, nome, texto) {
    const resultado = await this.repoPrompts.definirPrompt(chatId, nome, texto);
    
    return Resultado.dobrar(
      resultado,
      () => {
        
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao definir prompt: ${erro.message}`);
        throw erro;
      }
    );
  }

  async obterPromptSistema(chatId, nome) {
    const resultado = await this.repoPrompts.obterPrompt(chatId, nome);
    
    return Resultado.dobrar(
      resultado,
      (prompt) => prompt,
      (erro) => {
        this.registrador.error(`Erro ao obter prompt: ${erro.message}`);
        throw erro;
      }
    );
  }

  async listarPromptsSistema(chatId) {
    const resultado = await this.repoPrompts.listarPrompts(chatId);
    
    return Resultado.dobrar(
      resultado,
      (prompts) => prompts,
      (erro) => {
        this.registrador.error(`Erro ao listar prompts: ${erro.message}`);
        throw erro;
      }
    );
  }

  async definirPromptSistemaAtivo(chatId, nomePrompt) {
    try {
      const prompt = await this.obterPromptSistema(chatId, nomePrompt);
      if (prompt) {
        await this.definirConfig(chatId, 'activePrompt', nomePrompt);
        
        return true;
      }
      this.registrador.warn(`Prompt ${nomePrompt} não encontrado para ${chatId}`);
      return false;
    } catch (erro) {
      this.registrador.error(`Erro ao definir prompt ativo: ${erro.message}`);
      return false;
    }
  }

  async limparPromptSistemaAtivo(chatId) {
    try {
      await this.definirConfig(chatId, 'activePrompt', null);
      
      return true;
    } catch (erro) {
      this.registrador.error(`Erro ao limpar prompt ativo: ${erro.message}`);
      return false;
    }
  }

  async excluirPromptSistema(chatId, nome) {
    const resultado = await this.repoPrompts.excluirPrompt(chatId, nome);
    
    return Resultado.dobrar(
      resultado,
      (sucesso) => {
        if (sucesso) {
          this.registrador.info(`Prompt ${nome} excluído para ${chatId}`);
          return true;
        } else {
          this.registrador.warn(`Prompt ${nome} não encontrado para exclusão`);
          return false;
        }
      },
      (erro) => {
        this.registrador.error(`Erro ao excluir prompt: ${erro.message}`);
        throw erro;
      }
    );
  }

  async obterOuCriarGrupo(chat) {
    const resultado = await this.repoGrupos.obterOuCriarGrupo(chat);
    
    return Resultado.dobrar(
      resultado,
      (grupo) => grupo,
      (erro) => {
        this.registrador.error(`Erro ao processar grupo: ${erro.message}`);
        throw erro;
      }
    );
  }

  async obterOuCriarUsuario(remetente, cliente) {
    const resultado = await this.repoUsuarios.obterOuCriarUsuario(remetente, cliente);
    
    return Resultado.dobrar(
      resultado,
      (usuario) => usuario,
      (erro) => {
        this.registrador.error(`Erro ao processar usuário: ${erro.message}`);
        
        // Criar um usuário básico em caso de erro
        const idSufixo = remetente.substring(0, 6);
        return {
          id: remetente,
          name: `User${idSufixo}`,
          joinedAt: new Date()
        };
      }
    );
  }
}

module.exports = ConfigManager;
