/**
 * ProcessadorTexto - Processamento de mensagens de texto
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const { obterOuCriarUsuario } = require('../dominio/OperacoesChat');

const criarProcessadorTexto = (dependencias) => {
  const { 
    registrador, 
    adaptadorIA, 
    gerenciadorConfig, 
    gerenciadorTransacoes, 
    servicoMensagem, 
    clienteWhatsApp 
  } = dependencias;

  // Criar transação para esta mensagem
  const criarTransacao = async (mensagem, chat, remetente) => {
    try {
      const transacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
      registrador.debug(`Nova transação criada: ${transacao.id} para mensagem de ${remetente.name}`);
      return Resultado.sucesso(transacao);
    } catch (erro) {
      registrador.error(`Erro ao criar transação: ${erro.message}`);
      return Resultado.falha(erro);
    }
  };

  // Adicionar dados para recuperação
  const adicionarDadosRecuperacao = async (transacaoId, dados) => {
    try {
      await gerenciadorTransacoes.adicionarDadosRecuperacao(transacaoId, dados);
      return Resultado.sucesso(true);
    } catch (erro) {
      registrador.error(`Erro ao adicionar dados de recuperação: ${erro.message}`);
      return Resultado.sucesso(false); // Continuar mesmo assim
    }
  };

  // Formatar histórico de mensagens
  const formatarHistorico = (historico, mensagemAtual, nomeRemetente) => {
    // Verificar se a última mensagem já é a atual
    const ultimaMensagem = historico.length > 0 ? historico[historico.length - 1] : '';
    const mensagemUsuarioAtual = `${nomeRemetente}: ${mensagemAtual}`;

    // Só adiciona a mensagem atual se ela não for a última do histórico
    return ultimaMensagem.includes(mensagemAtual)
      ? `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}`
      : `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}\n${mensagemUsuarioAtual}`;
  };

  // Pipeline completo de processamento de texto usando composição funcional
  const processarMensagemTexto = async (dados) => {
    const { mensagem, chat, chatId } = dados;

    return Trilho.encadear(
      // Obter informações do remetente
      () => obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(mensagem.author || mensagem.from, chat),
      
      // Criar transação
      remetente => Trilho.dePromise(criarTransacao(mensagem, chat, remetente))
        .then(transacao => ({ transacao, remetente })),
      
      // Adicionar dados para recuperação
      dados => Trilho.dePromise(adicionarDadosRecuperacao(
        dados.transacao.id,
        {
          tipo: 'texto',
          remetenteId: mensagem.from,
          remetenteNome: dados.remetente.name,
          chatId: chatId,
          textoOriginal: mensagem.body,
          timestampOriginal: mensagem.timestamp
        }
      )).then(() => dados),
      
      // Marcar como processando
      dados => Trilho.dePromise(gerenciadorTransacoes.marcarComoProcessando(dados.transacao.id))
        .then(() => dados),
      
      // Obter histórico e configuração
      dados => Promise.all([
        clienteWhatsApp.obterHistoricoMensagens(chatId),
        gerenciadorConfig.obterConfig(chatId)
      ]).then(([historico, config]) => ({
        ...dados,
        historico,
        config
      })),
      
      // Gerar resposta da IA
      dados => {
        const textoHistorico = formatarHistorico(
          dados.historico, 
          mensagem.body, 
          dados.remetente.name
        );
        
        return adaptadorIA.processarTexto(textoHistorico, dados.config)
          .then(resultado => ({ 
            ...dados, 
            resposta: resultado.dados 
          }));
      },
      
      // Adicionar resposta à transação
      dados => Trilho.dePromise(
        gerenciadorTransacoes.adicionarRespostaTransacao(dados.transacao.id, dados.resposta)
      ).then(() => dados),
      
      // Enviar a resposta
      dados => Trilho.dePromise(
        servicoMensagem.enviarResposta(mensagem, dados.resposta, dados.transacao.id)
      ).then(() => {
        registrador.info(`Resposta de texto enviada - ${dados.transacao.id}`);
        return Resultado.sucesso({ transacao: dados.transacao, resposta: dados.resposta });
      })
    )();
  };

  return { processarMensagemTexto };
};

module.exports = criarProcessadorTexto;