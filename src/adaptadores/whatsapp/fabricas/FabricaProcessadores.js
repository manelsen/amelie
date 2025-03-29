/**
 * FabricaProcessadores - Módulo para centralizar a criação dos processadores de mensagens do WhatsApp.
 */

// Importar criadores de processadores
const criarProcessadorTexto = require('../processadores/ProcessadorTexto');
const criarProcessadorComandos = require('../processadores/ProcessadorComandos');
const criarProcessadorAudio = require('../processadores/ProcessadorAudio');
const criarProcessadorImagem = require('../processadores/ProcessadorImagem');
const criarProcessadorVideo = require('../processadores/ProcessadorVideo');
const criarProcessadorDocumento = require('../processadores/ProcessadorDocumento');
const criarProcessadorMidia = require('../processadores/ProcessadorMidia');

// Importar criador do registro de comandos (necessário para ProcessadorComandos)
// Não precisamos mais importar criarRegistroComandos ou criarAdaptadorIA aqui


/**
 * Cria e configura todos os processadores de mensagens.
 * @param {object} dependencias - Objeto contendo todas as dependências necessárias (registrador, clienteWhatsApp, etc.).
 * @returns {object} - Um objeto contendo as instâncias dos processadores.
 */
const criarProcessadores = (dependencias) => {
  // Extrair adaptadorIA e registroComandos das dependências recebidas
  const { adaptadorIA, registroComandos } = dependencias;

  if (!adaptadorIA || !registroComandos) {
    // Lançar um erro ou logar se as dependências essenciais não foram passadas
    // Isso garante que GerenciadorMensagens está passando corretamente
    throw new Error("adaptadorIA e registroComandos são necessários em dependencias para criarProcessadores");
  }

  // Criar processadores específicos usando o adaptadorIA passado
  const processadorAudio = criarProcessadorAudio({
    ...dependencias,
    adaptadorIA
  });

  const processadorImagem = criarProcessadorImagem({
    ...dependencias,
    adaptadorIA
  });

  const processadorVideo = criarProcessadorVideo({
    ...dependencias,
    adaptadorIA
  });

  const processadorDocumento = criarProcessadorDocumento({
    ...dependencias,
    adaptadorIA
  });

  // Criar processador de mídia injetando os específicos
  const processadorMidia = criarProcessadorMidia({
    ...dependencias,
    adaptadorIA,
    processadorAudio,
    processadorImagem,
    processadorVideo,
    processadorDocumento
  });

  // Criar processador de texto
  const processadorTexto = criarProcessadorTexto({
    ...dependencias,
    adaptadorIA
  });

  // Criar processador de comandos usando o registroComandos passado
  const processadorComandos = criarProcessadorComandos({
    ...dependencias,
    registroComandos // Injetar o registroComandos recebido
  });

  // Retornar um objeto com todos os processadores instanciados
  return {
    processadorTexto,
    processadorComandos,
    processadorMidia,
    // Não precisamos retornar os processadores específicos (audio, imagem, video, doc)
    // pois eles são usados internamente pelo processadorMidia.
  };
};

module.exports = criarProcessadores;
