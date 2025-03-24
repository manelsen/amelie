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

    return Trilho.encadear(
      // Obter chat e configuração
      () => Promise.all([
        mensagem.getChat(),
        gerenciadorConfig.obterConfig(chatId)
      ]),
      
      // Verificar se processamento de vídeo está habilitado
      ([chat, config]) => {
        if (!config.mediaVideo) {
          registrador.debug(`Descrição de vídeo desabilitada para o chat ${chatId}. Ignorando mensagem de vídeo.`);
          return Resultado.falha(new Error("Descrição de vídeo desabilitada"));
        }
        
        return Resultado.sucesso({ chat, config });
      },
      
      // Obter informações do remetente
      dados => 
        obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(
          mensagem.author || mensagem.from, 
          dados.chat
        )
        .then(resultado => ({ ...dados, remetente: resultado.dados })),
      
      // Verificar tamanho do vídeo
      dados => {
        const resultadoTamanho = verificarTamanhoVideo(dadosAnexo);
        
        if (!resultadoTamanho.sucesso) {
          return Trilho.dePromise(
            servicoMensagem.enviarResposta(
              mensagem,
              "Desculpe, só posso processar vídeos de até 20MB. Este vídeo é muito grande para eu analisar."
            )
          )
          .then(() => {
            registrador.warn(`Vídeo muito grande (${dadosAnexo.data.length / (1024 * 1024).toFixed(2)}MB) recebido de ${dados.remetente.name}. Processamento rejeitado.`);
            return resultadoTamanho;
          });
        }
        
        return Resultado.sucesso(dados);
      },
      
      // Criar transação
      dados => Trilho.dePromise(
        gerenciadorTransacoes.criarTransacao(mensagem, dados.chat)
      )
      .then(transacao => ({ ...dados, transacao })),
      
      // Marcar como processando
      dados => Trilho.dePromise(
        gerenciadorTransacoes.marcarComoProcessando(dados.transacao.id)
      )
      .then(() => dados),
      
      // Determinar prompt do usuário baseado no modo
      dados => {
        const promptUsuario = determinarPromptUsuario(dados.config, mensagem.body);
        
        if (dados.config.modoDescricao === 'legenda' || dados.config.usarLegenda === true) {
          registrador.info(`🎬👂 Aplicando prompt específico para LEGENDAGEM (transação ${dados.transacao.id})`);
        }
        
        return Resultado.sucesso({ ...dados, promptUsuario });
      },
      
      // Salvar arquivo temporário
      dados => salvarArquivoTemporario(dadosAnexo)
        .then(resultado => {
          arquivoTemporario = resultado.dados;
          return { ...dados, arquivoTemporario };
        }),
      
      // Adicionar à fila de processamento
      dados => {
        // Preparar opções adicionais
        const opcoesAdicionais = {};
        if (dados.config.modoDescricao === 'legenda' || dados.config.usarLegenda === true) {
          opcoesAdicionais.modoLegenda = true;
        }
        
        // Payload para fila
        const payload = {
          tempFilename: dados.arquivoTemporario,
          chatId,
          messageId: mensagem.id._serialized,
          mimeType: dadosAnexo.mimetype,
          userPrompt: dados.promptUsuario,
          senderNumber: mensagem.from,
          transacaoId: dados.transacao.id,
          remetenteName: dados.remetente.name,
          modoDescricao: dados.config.modoDescricao || 'curto',
          usarLegenda: dados.config.usarLegenda === true,
          ...opcoesAdicionais
        };
        
        return Trilho.dePromise(filasMidia.adicionarVideo(payload))
          .then(() => dados);
      }
    )()
    .then(dados => {
      registrador.debug(`🚀 Vídeo de ${dados.remetente.name} adicionado à fila com sucesso: ${dados.arquivoTemporario}`);
      return Resultado.sucesso({ transacao: dados.transacao });
    })
    .catch(erro => {
      // Ignorar erros de configuração
      if (erro.message === "Descrição de vídeo desabilitada" ||
          erro.message.startsWith("Vídeo muito grande")) {
        return Resultado.falha(erro);
      }
      
      registrador.error(`❌ Erro ao processar vídeo: ${erro.message}`);
      
      // Registrar falha na transação se houver
      if (dados && dados.transacao) {
        gerenciadorTransacoes.registrarFalhaEntrega(
          dados.transacao.id, 
          `Erro no processamento: ${erro.message}`
        ).catch(e => {
          registrador.error(`Erro ao registrar falha: ${e.message}`);
        });
      }
      
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
      
      return Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, mensagemAmigavel))
        .then(() => Resultado.falha(erro));
    });
  };

  return { processarMensagemVideo };
};

module.exports = criarProcessadorVideo;