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
    // Chama diretamente, pois gerenciadorAI.processarTexto já retorna Promise<Resultado>
    gerenciadorAI.processarTexto(textoHistorico, config)
    // O erro já é logado e encapsulado em Resultado.falha dentro de processarTexto
  );

  // Processamento de imagem com seleção inteligente de prompt
  const processarImagem = _.curry((dadosImagem, promptUsuario, config) => {
    const selecionarPrompt = _.cond([
      [config => config.modoDescricao === 'longo', _.constant(InstrucoesSistema.obterPromptImagem())],
      [_.stubTrue, _.constant(InstrucoesSistema.obterPromptImagemCurto())]
    ]);
    
    const promptBase = selecionarPrompt(config);
    
    // Chama diretamente, pois gerenciadorAI.processarImagem já retorna Promise<Resultado>
    return gerenciadorAI.processarImagem(dadosImagem, promptBase, config);
    // O erro já é logado e encapsulado em Resultado.falha dentro de processarImagem
  });

  // Processamento de áudio
  const processarAudio = _.curry((dadosAudio, hashAudio, config) =>
    // Chama diretamente, pois gerenciadorAI.processarAudio já retorna Promise<Resultado>
    gerenciadorAI.processarAudio(dadosAudio, hashAudio, config)
    // O erro já é logado e encapsulado em Resultado.falha dentro de processarAudio
  );

  // Processamento de vídeo com seleção de prompt baseada no modo
  const processarVideo = _.curry((dadosVideo, caminhoVideo, promptUsuario, config) => {
    const selecionarPrompt = _.cond([
      [config => config.modoDescricao === 'longo', _.constant(InstrucoesSistema.obterPromptVideo())],
      [config => config.modoDescricao === 'legenda' || config.usarLegenda === true, 
        _.constant(InstrucoesSistema.obterPromptVideoLegenda())],
      [_.stubTrue, _.constant(InstrucoesSistema.obterPromptVideoCurto())]
    ]);
    
    const promptBase = selecionarPrompt(config);
    
    // Chama diretamente, pois gerenciadorAI.processarVideo já retorna Promise<Resultado>
    // Passar a config completa, pois processarVideo pode precisar dela
    return gerenciadorAI.processarVideo(caminhoVideo, promptBase, config);
     // O erro já é logado e encapsulado em Resultado.falha dentro de processarVideo
  });

  return {
    processarTexto,
    processarImagem,
    processarAudio,
    processarVideo
  };
});

module.exports = criarAdaptadorIA;