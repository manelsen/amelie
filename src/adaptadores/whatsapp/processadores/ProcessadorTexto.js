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
  
    try {
      // Obter informações do remetente
      const resultadoRemetente = await obterOuCriarUsuario(
        gerenciadorConfig, 
        clienteWhatsApp, 
        registrador
      )(mensagem.author || mensagem.from, chat);
      
      if (!resultadoRemetente.sucesso) {
        return resultadoRemetente;
      }
      
      const remetente = resultadoRemetente.dados;
      registrador.debug(`Remetente encontrado: ${remetente.name}`);
      
      // Criar transação
      const transacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
      registrador.debug(`Nova transação criada: ${transacao.id} para mensagem de ${remetente.name}`);
      
      // Adicionar dados para recuperação
      await gerenciadorTransacoes.adicionarDadosRecuperacao(
        transacao.id,
        {
          tipo: 'texto',
          remetenteId: mensagem.from,
          remetenteNome: remetente.name,
          chatId: chatId,
          textoOriginal: mensagem.body,
          timestampOriginal: mensagem.timestamp
        }
      );
      
      // Marcar como processando
      await gerenciadorTransacoes.marcarComoProcessando(transacao.id);
      
      // Obter histórico e configuração
      const historico = await clienteWhatsApp.obterHistoricoMensagens(chatId);
      const config = await gerenciadorConfig.obterConfig(chatId);
      
      // Verificar se a última mensagem já é a atual
      const ultimaMensagem = historico.length > 0 ? historico[historico.length - 1] : '';
      const mensagemUsuarioAtual = `${remetente.name}: ${mensagem.body}`;
      
      // Formatar histórico
      const textoHistorico = ultimaMensagem.includes(mensagem.body)
        ? `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}`
        : `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}\n${mensagemUsuarioAtual}`;
      
      // Processar com IA através do adaptadorIA (não gerenciadorAI diretamente)
      registrador.debug(`Enviando texto para processamento: ${textoHistorico.substring(0, 50)}...`);
      const resultadoResposta = await adaptadorIA.processarTexto(textoHistorico, config);
      
      if (!resultadoResposta.sucesso) {
        return resultadoResposta;
      }
      
      const resposta = resultadoResposta.dados;
      
      // Adicionar resposta à transação
      await gerenciadorTransacoes.adicionarRespostaTransacao(transacao.id, resposta);
      
      // Enviar a resposta
      await servicoMensagem.enviarResposta(mensagem, resposta, transacao.id);
      registrador.info(`Resposta de texto enviada - ${transacao.id}`);
      
      return Resultado.sucesso({ transacao, resposta });
      
    } catch (erro) {
      registrador.error(`Erro ao processar mensagem de texto: ${erro.message}`, erro);
      return Resultado.falha(erro);
    }
  };

  return { processarMensagemTexto };
};

module.exports = criarProcessadorTexto;