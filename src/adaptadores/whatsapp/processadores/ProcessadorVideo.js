/**
 * ProcessadorVideo - Processamento específico para mensagens com vídeos
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const { obterOuCriarUsuario } = require('../dominio/OperacoesChat');
const fs = require('fs');
const path = require('path');
const InstrucoesSistema = require('../../../config/InstrucoesSistema');

const criarProcessadorVideo = (dependencias) => {
  const { 
    registrador, 
    gerenciadorConfig, 
    gerenciadorTransacoes, 
    servicoMensagem, 
    filasMidia, 
    clienteWhatsApp 
  } = dependencias;

  // Verificar tamanho do vídeo
  const verificarTamanhoVideo = _.curry((dadosAnexo, limiteMB = 20) => {
    const tamanhoVideoMB = dadosAnexo.data.length / (1024 * 1024);
    
    if (tamanhoVideoMB > limiteMB) {
      return Resultado.falha(new Error(`Vídeo muito grande (${tamanhoVideoMB.toFixed(2)}MB). Limite: ${limiteMB}MB`));
    }
    
    return Resultado.sucesso({ dadosAnexo, tamanhoVideoMB });
  });

  // Salvar arquivo de vídeo temporário
  const salvarArquivoTemporario = _.curry(async (dadosAnexo) => {
    try {
      // Criar nome de arquivo único
      const dataHora = new Date().toISOString().replace(/[:.]/g, '-');
      const arquivoTemporario = `./temp/video_${dataHora}_${Math.floor(Math.random() * 10000)}.mp4`;
      
      // Garantir que o diretório existe
      const diretorio = path.dirname(arquivoTemporario);
      await fs.promises.mkdir(diretorio, { recursive: true });
      
      // Salvar o arquivo
      registrador.debug(`Salvando arquivo de vídeo ${arquivoTemporario}...`);
      const videoBuffer = Buffer.from(dadosAnexo.data, 'base64');
      
      await fs.promises.writeFile(arquivoTemporario, videoBuffer);
      
      // Verificar se o arquivo foi salvo corretamente
      const stats = await fs.promises.stat(arquivoTemporario);
      if (stats.size !== videoBuffer.length) {
        throw new Error(`Tamanho do arquivo salvo (${stats.size}) não corresponde ao buffer original (${videoBuffer.length})`);
      }
      
      registrador.debug(`✅ Arquivo de vídeo salvo com sucesso: ${arquivoTemporario} (${Math.round(videoBuffer.length / 1024)} KB)`);
      return Resultado.sucesso(arquivoTemporario);
    } catch (erro) {
      registrador.error(`Erro ao salvar arquivo temporário: ${erro.message}`);
      return Resultado.falha(erro);
    }
  });

  // Determinar prompt do usuário baseado no modo
  const determinarPromptUsuario = _.curry((config, mensagemBody) => {
    // Verificar o modo legenda explicitamente
    if (config.modoDescricao === 'legenda' || config.usarLegenda === true) {
      return InstrucoesSistema.obterPromptVideoLegenda();
    } 
    
    if (mensagemBody && mensagemBody.trim() !== '') {
      return mensagemBody.trim();
    } 
    
    if (config.modoDescricao === 'longo') {
      return InstrucoesSistema.obterPromptVideo();
    }
    
    // Modo padrão - curto
    return InstrucoesSistema.obterPromptVideoCurto();
  });

  // Função principal de processamento de vídeo
  const processarMensagemVideo = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;
    let arquivoTemporario = null;
  
    try {
      // Obter chat
      const chat = await mensagem.getChat();
      
      // Obter configuração
      const config = await gerenciadorConfig.obterConfig(chatId);
      
      // Verificar se processamento de vídeo está habilitado
      if (!config.mediaVideo) {
        registrador.debug(`Descrição de vídeo desabilitada para o chat ${chatId}. Ignorando mensagem de vídeo.`);
        return Resultado.falha(new Error("Descrição de vídeo desabilitada"));
      }
      
      // Obter informações do remetente de forma direta
      const resultadoRemetente = await obterOuCriarUsuario(
        gerenciadorConfig, 
        clienteWhatsApp, 
        registrador
      )(mensagem.author || mensagem.from, chat);
      
      if (!resultadoRemetente.sucesso) {
        registrador.error(`Falha ao obter remetente: ${resultadoRemetente.erro?.message}`);
        return resultadoRemetente;
      }
      
      const remetente = resultadoRemetente.dados;
      registrador.debug(`Remetente encontrado: ${remetente.name}`);
      
      // Verificar tamanho do vídeo
      const tamanhoVideoMB = dadosAnexo.data.length / (1024 * 1024);
      if (tamanhoVideoMB > 20) {
        await servicoMensagem.enviarResposta(
          mensagem,
          "Desculpe, só posso processar vídeos de até 20MB. Este vídeo é muito grande para eu analisar."
        );
        
        registrador.warn(`Vídeo muito grande (${tamanhoVideoMB.toFixed(2)}MB) recebido de ${remetente.name}. Processamento rejeitado.`);
        return Resultado.falha(new Error(`Vídeo muito grande (${tamanhoVideoMB.toFixed(2)}MB)`));
      }
      
      // Criar transação
      const transacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
      registrador.debug(`Nova transação criada: ${transacao.id} para mensagem de vídeo de ${remetente.name}`);
      
      // Marcar como processando
      await gerenciadorTransacoes.marcarComoProcessando(transacao.id);
      
      // Determinar prompt do usuário baseado no modo
      let promptUsuario = "";
      
      // Verificar o modo legenda explicitamente
      if (config.modoDescricao === 'legenda' || config.usarLegenda === true) {
        registrador.info(`🎬👂 Aplicando prompt específico para LEGENDAGEM (transação ${transacao.id})`);
        promptUsuario = `Transcreva verbatim e em português o conteúdo deste vídeo, criando uma legenda acessível para pessoas surdas.
  Siga estas diretrizes:
  1. Use timecodes precisos no formato [MM:SS] para cada fala ou mudança de som
  2. Identifique quem está falando quando possível (Ex: João: texto da fala)
  3. Indique entre colchetes sons ambientais importantes, música e efeitos sonoros
  4. Descreva o tom emocional das falas (Ex: [voz triste], [gritando])
  5. Transcreva TUDO que é dito, palavra por palavra, incluindo hesitações
  6. Indique mudanças na música de fundo`;
      } else if (mensagem.body && mensagem.body.trim() !== '') {
        promptUsuario = mensagem.body.trim();
      } else if (config.modoDescricao === 'longo') {
        promptUsuario = `Analise este vídeo de forma extremamente detalhada para pessoas com deficiência visual.
  Inclua:
  1. Número exato de pessoas, suas posições e roupas (cores, tipos)
  2. Ambiente e cenário completo
  3. Todos os objetos visíveis 
  4. Movimentos e ações detalhadas
  5. Expressões faciais e tons de voz
  6. Textos visíveis
  7. Qualquer outro detalhe relevante`;
      }
      
      // Cria um arquivo temporário para o vídeo
      const dataHora = new Date().toISOString().replace(/[:.]/g, '-');
      arquivoTemporario = `./temp/video_${dataHora}_${Math.floor(Math.random() * 10000)}.mp4`;
      
      // Garantir que o diretório existe
      const diretorio = path.dirname(arquivoTemporario);
      await fs.promises.mkdir(diretorio, { recursive: true });
      
      // Salvar o arquivo
      registrador.debug(`Salvando arquivo de vídeo ${arquivoTemporario}...`);
      const videoBuffer = Buffer.from(dadosAnexo.data, 'base64');
      
      await fs.promises.writeFile(arquivoTemporario, videoBuffer);
      
      // Verificar se o arquivo foi salvo corretamente
      const stats = await fs.promises.stat(arquivoTemporario);
      if (stats.size !== videoBuffer.length) {
        throw new Error(`Tamanho do arquivo salvo (${stats.size}) não corresponde ao buffer original (${videoBuffer.length})`);
      }
      
      registrador.debug(`✅ Arquivo de vídeo salvo com sucesso: ${arquivoTemporario} (${Math.round(videoBuffer.length / 1024)} KB)`);
      
      // Passar informação de legenda nas opções
      const opcoesAdicionais = {};
      if (config.modoDescricao === 'legenda' || config.usarLegenda === true) {
        opcoesAdicionais.modoLegenda = true;
      }
      
      // Adicionar vídeo à fila
      await filasMidia.adicionarVideo({
        tempFilename: arquivoTemporario,
        chatId,
        messageId: mensagem.id._serialized,
        mimeType: dadosAnexo.mimetype,
        userPrompt: promptUsuario,
        senderNumber: mensagem.from,
        transacaoId: transacao.id,
        remetenteName: remetente.name,
        modoDescricao: config.modoDescricao || 'curto',
        usarLegenda: config.usarLegenda === true,
        ...opcoesAdicionais
      });
      
      registrador.debug(`🚀 Vídeo de ${remetente.name} adicionado à fila com sucesso: ${arquivoTemporario}`);
      return Resultado.sucesso({ transacao });
      
    } catch (erro) {
      registrador.error(`❌ Erro ao processar vídeo: ${erro.message}`);
      
      // Limpar arquivo temporário se existir
      if (arquivoTemporario && fs.existsSync(arquivoTemporario)) {
        fs.promises.unlink(arquivoTemporario).catch(err => {
          registrador.error(`Erro ao remover arquivo temporário: ${err.message}`);
        });
        registrador.info(`Arquivo temporário ${arquivoTemporario} removido após erro`);
      }
      
      // Enviar mensagem amigável baseada no tipo de erro
      let mensagemAmigavel = 'Desculpe, ocorreu um erro ao adicionar seu vídeo à fila de processamento.';
      
      if (erro.message.includes('too large')) {
        mensagemAmigavel = 'Ops! Este vídeo parece ser muito grande para eu processar. Poderia enviar uma versão menor ou comprimida?';
      } else if (erro.message.includes('format')) {
        mensagemAmigavel = 'Esse formato de vídeo está me dando trabalho! Poderia tentar enviar em outro formato?';
      } else if (erro.message.includes('timeout')) {
        mensagemAmigavel = 'O processamento demorou mais que o esperado. Talvez o vídeo seja muito complexo?';
      }
      
      try {
        await servicoMensagem.enviarResposta(mensagem, mensagemAmigavel);
      } catch (erroEnvio) {
        registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
      }
      
      return Resultado.falha(erro);
    }
  };

  return { processarMensagemVideo };
};

module.exports = criarProcessadorVideo;