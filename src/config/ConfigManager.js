/**
 * ConfigManager - Gerencia configurações e preferências
 * 
 * Este módulo centraliza o acesso a todas as configurações do sistema,
 * incluindo prompts de sistema, preferências de usuário e configurações do bot.
 */

const Datastore = require('nedb');
const path = require('path');
const fs = require('fs');

class ConfigManager {
  /**
   * Cria uma instância do gerenciador de configurações
   * @param {Object} registrador - Objeto logger para registro de eventos
   * @param {string} diretorioDB - Diretório para os bancos de dados
   */
  constructor(registrador, diretorioDB = path.join(process.cwd(), 'db')) {
    this.registrador = registrador;
    this.diretorioDB = diretorioDB;
    
    // Garantir que o diretório do banco de dados exista
    if (!fs.existsSync(this.diretorioDB)) {
      fs.mkdirSync(this.diretorioDB, { recursive: true });
      this.registrador.info('Diretório de banco de dados criado');
    }
    
    // Inicializar bancos de dados
    this.promptsDb = new Datastore({ filename: path.join(this.diretorioDB, 'prompts.db'), autoload: true });
    this.configDb = new Datastore({ filename: path.join(this.diretorioDB, 'config.db'), autoload: true });
    this.groupsDb = new Datastore({ filename: path.join(this.diretorioDB, 'groups.db'), autoload: true });
    this.usersDb = new Datastore({ filename: path.join(this.diretorioDB, 'users.db'), autoload: true });
    
// Configuração padrão para a assistente
this.configPadrao = {
  temperature: 0.9,
  topK: 1,
  topP: 0.95,
  maxOutputTokens: 1024,
  mediaImage: true,  
  mediaAudio: false,  
  mediaVideo: true,
  modoDescricao: 'curto' // Adicionado com padrão 'curto'
};
    
    this.registrador.info('Gerenciador de configurações inicializado');
  }

  /**
   * Define um parâmetro de configuração
   * @param {string} chatId - ID do chat
   * @param {string} param - Nome do parâmetro
   * @param {any} valor - Valor do parâmetro
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async definirConfig(chatId, param, valor) {
    return new Promise((resolve, reject) => {
      this.configDb.update(
        { chatId },
        { $set: { [param]: valor } },
        { upsert: true },
        (err) => {
          if (err) {
            this.registrador.error(`Erro ao definir configuração: ${err.message}`);
            reject(err);
          } else {
            this.registrador.debug(`Configuração ${param}=${valor} definida para ${chatId}`);
            resolve(true);
          }
        }
      );
    });
  }

  /**
   * Obtém as configurações de um chat
   * @param {string} chatId - ID do chat
   * @returns {Promise<Object>} Configurações do chat
   */
  async obterConfig(chatId) {
    return new Promise((resolve, reject) => {
      this.configDb.findOne({ chatId }, async (err, doc) => {
        if (err) {
          this.registrador.error(`Erro ao obter configuração: ${err.message}`);
          reject(err);
        } else {
          const configUsuario = doc || {};
          const config = { ...this.configPadrao, ...configUsuario };
          
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

        resolve(config);
      }
    });
  });
}

/**
 * Reseta as configurações para valores padrão
 * @param {string} chatId - ID do chat
 * @returns {Promise<boolean>} Sucesso da operação
 */
async resetarConfig(chatId) {
  return new Promise((resolve, reject) => {
    this.configDb.update(
      { chatId },
      { $set: {
        ...this.configPadrao,
        modoDescricao: 'curto', // Alterado para 'curto' como padrão
        descricaoLonga: false,
        descricaoCurta: true,
        activePrompt: null // Limpar prompt ativo
      }},
      { upsert: true },
      (err) => {
        if (err) {
          this.registrador.error(`Erro ao resetar configuração: ${err.message}`);
          reject(err);
        } else {
          this.registrador.info(`Configurações resetadas para ${chatId}`);
          resolve(true);
        }
      }
    );
  });
}

/**
 * Define um prompt de sistema
 * @param {string} chatId - ID do chat
 * @param {string} nome - Nome do prompt
 * @param {string} texto - Texto do prompt
 * @returns {Promise<boolean>} Sucesso da operação
 */
async definirPromptSistema(chatId, nome, texto) {
  return new Promise((resolve, reject) => {
    const textoFormatado = `Seu nome é ${nome}. ${texto}`;
    this.promptsDb.update(
      { chatId, name: nome }, 
      { chatId, name: nome, text: textoFormatado }, 
      { upsert: true }, 
      (err) => {
        if (err) {
          this.registrador.error(`Erro ao definir prompt: ${err.message}`);
          reject(err);
        } else {
          this.registrador.debug(`Prompt ${nome} definido para ${chatId}`);
          resolve(true);
        }
      }
    );
  });
}

/**
 * Obtém um prompt de sistema pelo nome
 * @param {string} chatId - ID do chat
 * @param {string} nome - Nome do prompt
 * @returns {Promise<Object>} Prompt encontrado ou null
 */
async obterPromptSistema(chatId, nome) {
  return new Promise((resolve, reject) => {
    this.promptsDb.findOne({ chatId, name: nome }, (err, doc) => {
      if (err) {
        this.registrador.error(`Erro ao obter prompt: ${err.message}`);
        reject(err);
      } else {
        resolve(doc);
      }
    });
  });
}

/**
 * Lista todos os prompts de sistema para um chat
 * @param {string} chatId - ID do chat
 * @returns {Promise<Array>} Lista de prompts
 */
async listarPromptsSistema(chatId) {
  return new Promise((resolve, reject) => {
    this.promptsDb.find({ chatId }, (err, docs) => {
      if (err) {
        this.registrador.error(`Erro ao listar prompts: ${err.message}`);
        reject(err);
      } else {
        resolve(docs);
      }
    });
  });
}

/**
 * Define um prompt de sistema como ativo
 * @param {string} chatId - ID do chat
 * @param {string} nomePrompt - Nome do prompt
 * @returns {Promise<boolean>} Sucesso da operação
 */
async definirPromptSistemaAtivo(chatId, nomePrompt) {
  try {
    const prompt = await this.obterPromptSistema(chatId, nomePrompt);
    if (prompt) {
      await this.definirConfig(chatId, 'activePrompt', nomePrompt);
      this.registrador.debug(`Prompt ativo definido para ${chatId}: ${nomePrompt}`);
      return true;
    }
    this.registrador.warn(`Prompt ${nomePrompt} não encontrado para ${chatId}`);
    return false;
  } catch (erro) {
    this.registrador.error(`Erro ao definir prompt ativo: ${erro.message}`);
    return false;
  }
}

/**
 * Remove o prompt de sistema ativo
 * @param {string} chatId - ID do chat
 * @returns {Promise<boolean>} Sucesso da operação
 */
async limparPromptSistemaAtivo(chatId) {
  try {
    await this.definirConfig(chatId, 'activePrompt', null);
    this.registrador.debug(`Prompt ativo removido para ${chatId}`);
    return true;
  } catch (erro) {
    this.registrador.error(`Erro ao limpar prompt ativo: ${erro.message}`);
    return false;
  }
}

/**
 * Exclui um prompt de sistema
 * @param {string} chatId - ID do chat
 * @param {string} nome - Nome do prompt
 * @returns {Promise<boolean>} Sucesso da operação
 */
async excluirPromptSistema(chatId, nome) {
  return new Promise((resolve, reject) => {
    this.promptsDb.remove({ chatId, name: nome }, {}, (err, numRemoved) => {
      if (err) {
        this.registrador.error(`Erro ao excluir prompt: ${err.message}`);
        reject(err);
      } else if (numRemoved === 0) {
        this.registrador.warn(`Prompt ${nome} não encontrado para exclusão`);
        resolve(false);
      } else {
        this.registrador.info(`Prompt ${nome} excluído para ${chatId}`);
        resolve(true);
      }
    });
  });
}

/**
 * Obtém ou cria um registro de grupo
 * @param {Object} chat - Objeto do chat
 * @returns {Promise<Object>} Informações do grupo
 */
async obterOuCriarGrupo(chat) {
  return new Promise((resolve, reject) => {
    const grupoId = chat.id._serialized;
    this.groupsDb.findOne({ id: grupoId }, async (err, grupo) => {
      if (err) {
        this.registrador.error(`Erro ao buscar grupo: ${err.message}`);
        reject(err);
      } else if (grupo) {
        // Atualizar título se mudou
        if (grupo.title !== chat.name) {
          this.groupsDb.update(
            { id: grupoId }, 
            { $set: { title: chat.name } }, 
            {}, 
            (err) => {
              if (err) {
                this.registrador.error(`Erro ao atualizar título do grupo ${grupoId}: ${err.message}`);
              }
            }
          );
        }
        resolve(grupo);
      } else {
        try {
          const novoGrupo = {
            id: grupoId,
            title: chat.name || `Grupo_${grupoId.substring(0, 6)}`,
            createdAt: new Date()
          };
          this.groupsDb.insert(novoGrupo, (err, doc) => {
            if (err) {
              this.registrador.error(`Erro ao criar grupo: ${err.message}`);
              reject(err);
            } else {
              this.registrador.info(`Novo grupo registrado: ${doc.title}`);
              resolve(doc);
            }
          });
        } catch (erro) {
          this.registrador.error(`Erro ao processar grupo: ${erro.message}`);
          reject(erro);
        }
      }
    });
  });
}

/**
 * Obtém ou cria um registro de usuário
 * @param {string} remetente - ID do remetente
 * @param {Object} cliente - Instância do cliente WhatsApp
 * @returns {Promise<Object>} Informações do usuário
 */
async obterOuCriarUsuario(remetente, cliente) {
  return new Promise((resolve, reject) => {
    this.usersDb.findOne({ id: remetente }, async (err, usuario) => {
      if (err) {
        this.registrador.error(`Erro ao buscar usuário: ${err.message}`);
        reject(err);
      } else if (usuario) {
        resolve(usuario);
      } else {
        try {
          // Buscar informações do contato
          let nome;
          try {
            const contato = await cliente.getContactById(remetente);
            nome = contato.pushname || contato.name || contato.shortName;
          } catch (erroContato) {
            nome = null;
          }
          
          if (!nome || nome.trim() === '') {
            const idSufixo = remetente.substring(0, 6);
            nome = `User${idSufixo}`;
          }

          const novoUsuario = {
            id: remetente,
            name: nome,
            joinedAt: new Date()
          };
          
          this.usersDb.insert(novoUsuario, (err, doc) => {
            if (err) {
              this.registrador.error(`Erro ao criar usuário: ${err.message}`);
              reject(err);
            } else {
              this.registrador.info(`Novo usuário registrado: ${doc.name}`);
              resolve(doc);
            }
          });
        } catch (erro) {
          this.registrador.error(`Erro ao processar usuário: ${erro.message}`);
          
          // Criar um usuário básico em caso de erro
          const idSufixo = remetente.substring(0, 6);
          const novoUsuario = {
            id: remetente,
            name: `User${idSufixo}`,
            joinedAt: new Date()
          };
          
          this.usersDb.insert(novoUsuario, (err, doc) => {
            if (err) reject(err);
            else resolve(doc);
          });
        }
      }
    });
  });
}
}

module.exports = ConfigManager;