/**
 * AdaptadorIA - Isola as chamadas ao serviço de IA
 * Facilita futura migração para outros provedores como o Mistral
 */
const _ = require('lodash/fp');
const { Trilho, Resultado } = require('../../../utilitarios/Ferrovia');
const InstrucoesSistema = require('../../../config/InstrucoesSistema');

const criarAdaptadorIA = _.curry((registrador, gerenciadorAI) => {
  // Processamento de texto com curry para composição
  const processarTexto = _.curry((textoHistorico, config) => 
    Trilho.dePromise(gerenciadorAI.processarTexto(textoHistorico, config))
      .catch(erro => {
        registrador.error(`Erro no processamento de texto: ${erro.message}`);
        return Resultado.falha(erro);
      }));

  // Processamento de imagem com seleção inteligente de prompt
  const processarImagem = _.curry((dadosImagem, promptUsuario, config) => {
    const selecionarPrompt = _.cond([
      [config => config.modoDescricao === 'longo', _.constant(InstrucoesSistema.obterPromptImagem())],
      [_.stubTrue, _.constant(InstrucoesSistema.obterPromptImagemCurto())]
    ]);
    
    const promptBase = selecionarPrompt(config);
    
    return Trilho.dePromise(
      gerenciadorAI.processarImagem(dadosImagem, promptBase, promptUsuario)
    ).catch(erro => {
      registrador.error(`Erro no processamento de imagem: ${erro.message}`);
      return Resultado.falha(erro);
    });
  });

  // Processamento de áudio
  const processarAudio = _.curry((dadosAudio, hashAudio, config) => 
    Trilho.dePromise(gerenciadorAI.processarAudio(dadosAudio, hashAudio, config))
      .catch(erro => {
        registrador.error(`Erro no processamento de áudio: ${erro.message}`);
        return Resultado.falha(erro);
      }));

  // Processamento de vídeo com seleção de prompt baseada no modo
  const processarVideo = _.curry((dadosVideo, caminhoVideo, promptUsuario, config) => {
    const selecionarPrompt = _.cond([
      [config => config.modoDescricao === 'longo', _.constant(InstrucoesSistema.obterPromptVideo())],
      [config => config.modoDescricao === 'legenda' || config.usarLegenda === true, 
        _.constant(InstrucoesSistema.obterPromptVideoLegenda())],
      [_.stubTrue, _.constant(InstrucoesSistema.obterPromptVideoCurto())]
    ]);
    
    const promptBase = selecionarPrompt(config);
    
    return Trilho.dePromise(
      gerenciadorAI.processarVideo(caminhoVideo, promptBase, promptUsuario)
    ).catch(erro => {
      registrador.error(`Erro no processamento de vídeo: ${erro.message}`);
      return Resultado.falha(erro);
    });
  });

  return {
    processarTexto,
    processarImagem,
    processarAudio,
    processarVideo
  };
});

module.exports = criarAdaptadorIA;