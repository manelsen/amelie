/**
 * ProcessadorImagem - Processamento específico para mensagens com imagens
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const { obterOuCriarUsuario } = require('../dominio/OperacoesChat');

const criarProcessadorImagem = (dependencias) => {
  const { 
    registrador, 
    gerenciadorConfig, 
    gerenciadorTransacoes, 
    servicoMensagem, 
    filasMidia, 
    clienteWhatsApp 
  } = dependencias;

  const processarMensagemImagem = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;

    return Trilho.encadear(
      // Obter chat e configuração
      () => Promise.all([
        mensagem.getChat(),
        gerenciadorConfig.obterConfig(chatId)
      ]),
      
      // Verificar se descrição de imagem está habilitada
      ([chat, config]) => {
        if (!config.mediaImage) {
          registrador.debug(`Descrição de imagem desabilitada para o chat ${chatId}. Ignorando mensagem de imagem.`);
          return Resultado.falha(new Error("Descrição de imagem desabilitada"));
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
      
      // Preparar dados de origem
      dados => {
        const dadosOrigem = {
          id: dados.chat.id._serialized,
          nome: dados.chat.isGroup ? dados.chat.name : dados.remetente.name,
          tipo: dados.chat.isGroup ? 'grupo' : 'usuario',
          remetenteId: mensagem.author || mensagem.from,
          remetenteNome: dados.remetente.name
        };
        
        return Resultado.sucesso({ ...dados, dadosOrigem });
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
      
      // Determinar prompt do usuário
      dados => {
        let promptUsuario = "";
        
        if (mensagem.body && mensagem.body.trim() !== '') {
          promptUsuario = mensagem.body.trim();
        }
        
        return Resultado.sucesso({ ...dados, promptUsuario });
      },
      
      // Adicionar à fila de processamento
      dados => {
        // Preparar payload para a fila
        const payload = {
          imageData: dadosAnexo,
          chatId,
          messageId: mensagem.id._serialized,
          mimeType: dadosAnexo.mimetype,
          userPrompt: dados.promptUsuario,
          senderNumber: mensagem.from,
          transacaoId: dados.transacao.id,
          remetenteName: dados.remetente.name,
          modoDescricao: dados.config.modoDescricao || 'curto',
          dadosOrigem: dados.dadosOrigem
        };
        
        return Trilho.dePromise(filasMidia.adicionarImagem(payload))
          .then(() => dados);
      }
    )()
    .then(dados => {
      registrador.debug(`🚀 Imagem de ${dados.remetente.name} adicionada à fila com sucesso (transação ${dados.transacao.id})`);
      return Resultado.sucesso({ transacao: dados.transacao });
    })
    .catch(erro => {
      // Ignorar erros de configuração
      if (erro.message === "Descrição de imagem desabilitada") {
        return Resultado.falha(erro);
      }
      
      registrador.error(`Erro ao processar mensagem de imagem: ${erro.message}`);
      
      // Verificar se é um erro de segurança
      if (erro.message.includes('SAFETY') || erro.message.includes('safety') ||
          erro.message.includes('blocked') || erro.message.includes('Blocked')) {
        
        registrador.warn(`⚠️ Conteúdo de imagem bloqueado por políticas de segurança`);
        
        return Trilho.dePromise(
          servicoMensagem.enviarResposta(
            mensagem, 
            'Este conteúdo não pôde ser processado por questões de segurança.'
          )
        )
        .then(() => Resultado.falha(erro));
      }
      
      return Trilho.dePromise(
        servicoMensagem.enviarResposta(
          mensagem, 
          'Desculpe, ocorreu um erro ao processar sua imagem.'
        )
      )
      .then(() => Resultado.falha(erro));
    });
  };

  return { processarMensagemImagem };
};

module.exports = criarProcessadorImagem;