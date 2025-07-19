const EventEmitter = require('events');
const path = require('path');
const { Resultado } = require('../../bancodedados/Repositorio');

class GerenciadorTransacoes extends EventEmitter {
  constructor(registrador, diretorioDB = path.join(process.cwd(), 'db')) {
    super();
    this.registrador = registrador;
    this.diretorioDB = diretorioDB;

    // Usando a nova arquitetura internamente
    const FabricaRepositorio = require('../../bancodedados/FabricaRepositorio');
    this.fabricaRepositorio = new FabricaRepositorio(registrador, diretorioDB);
    this.repoTransacoes = this.fabricaRepositorio.obterRepositorioTransacoes();

    // Limpar transações antigas na inicialização
    this.limparTransacoesAntigas();

    // Programar limpeza periódica
    setInterval(() => this.limparTransacoesAntigas(), 24 * 60 * 60 * 1000);

    this.registrador.info('Gerenciador de transações inicializado');
  }

  async limparTransacoesIncompletas() {
    // Refatorado: Usa buscarTransacoesIncompletas e removerTransacaoPorId
    const resultadoBusca = await this.repoTransacoes.buscarTransacoesIncompletas();

    // Dobra o resultado da busca
    return Resultado.dobrar(
      resultadoBusca,
      async (transacoes) => {
        if (!transacoes || transacoes.length === 0) {
          this.registrador.info('Nenhuma transação incompleta encontrada para limpeza.');
          return 0; // Retorna 0 se não há transações
        }

        this.registrador.info(`Encontradas ${transacoes.length} transações incompletas para limpeza.`);
        let limpas = 0;

        for (const transacao of transacoes) {
          // Verifica se a transação tem ID antes de tentar remover
          if (!transacao || !transacao.id) {
            this.registrador.warn('Transação incompleta sem ID encontrada durante a limpeza.');
            continue; // Pula para a próxima transação
          }

          const resultadoRemocao = await this.repoTransacoes.removerTransacaoPorId(transacao.id);
          if (resultadoRemocao.sucesso && resultadoRemocao.dados > 0) {
            limpas++;
          } else if (!resultadoRemocao.sucesso) {
            this.registrador.error(`Erro ao remover transação incompleta ${transacao.id}: ${resultadoRemocao.erro.message}`);
          }
          // Se resultadoRemocao.dados === 0, a transação pode ter sido removida por outro processo, não logamos erro.
        }

        this.registrador.info(`Limpas ${limpas} de ${transacoes.length} transações incompletas encontradas.`);
        return limpas; // Retorna o número de transações efetivamente limpas
      },
      (erro) => {
        this.registrador.error(`Erro ao buscar transações incompletas para limpeza: ${erro.message}`);
        // Em caso de erro na busca, retorna 0 ou lança o erro dependendo da política desejada
        // Optando por retornar 0 para não parar o processo periódico.
        return 0;
      }
    );
  }

  async criarTransacao(mensagem, chat) {
    // Refatorado: Extrai dados relevantes antes de chamar o repositório
    const dadosTransacao = {
      id: mensagem.id.id, // ID da mensagem
      chatId: chat.id._serialized, // ID do chat
      senderId: mensagem.id.remote, // ID do remetente (pode precisar de ajuste dependendo da estrutura)
      timestamp: new Date(mensagem.timestamp * 1000), // Timestamp da mensagem
      tipo: mensagem.type, // Tipo da mensagem (text, image, etc.)
      // Adicionar outros campos relevantes da mensagem/chat se necessário
      // Ex: mensagem.body, mensagem.caption, etc.
    };
    const resultado = await this.repoTransacoes.criarTransacao(dadosTransacao);

    return Resultado.dobrar(
      resultado,
      (documento) => {
        
        // CORREÇÃO AQUI: Envolva o documento em Resultado.sucesso()
        return Resultado.sucesso(documento);
      },
      (erro) => {
        this.registrador.error(`Erro ao criar transação: ${erro.message}`);
        // Manter o throw aqui está correto para o dobrar, mas o importante
        // é que o caminho de sucesso retorne um Resultado.sucesso.
        // Uma alternativa seria retornar Resultado.falha(erro) aqui também,
        // mas como o código chamador já trata o erro lançado, manter o throw funciona.
        throw erro;
      }
    );
  }

  async adicionarDadosRecuperacao(transacaoId, dadosRecuperacao) {
    const resultado = await this.repoTransacoes.adicionarDadosRecuperacao(transacaoId, dadosRecuperacao);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          this.registrador.warn(`Transação ${transacaoId} não encontrada para adicionar dados de recuperação`);
          return false;
        }
        
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao adicionar dados de recuperação: ${erro.message}`);
        throw erro;
      }
    );
  }

  async recuperarTransacoesIncompletas() {
    const resultado = await this.repoTransacoes.buscarTransacoesIncompletas();

    return Resultado.dobrar(
      resultado,
      async (transacoes) => {
        if (transacoes.length === 0) {
          this.registrador.info(`Nenhuma transação pendente para recuperação`);
          return 0;
        }

        this.registrador.info(`Recuperando ${transacoes.length} transações interrompidas...`);

        const recuperadas = await transacoes.reduce(async (contadorPromise, transacao) => {
          const contador = await contadorPromise;
          try {
            this.emit('transacao_para_recuperar', transacao);

            await this.atualizarStatusTransacao(
              transacao.id,
              'recuperacao_em_andamento',
              'Transação recuperada após restart do sistema'
            );

            return contador + 1;
          } catch (erro) {
            this.registrador.error(`Erro ao recuperar transação ${transacao.id}: ${erro.message}`);
            return contador;
          }
        }, Promise.resolve(0));

        this.registrador.info(`${recuperadas} transações enviadas para recuperação`);
        return recuperadas;
      },
      (erro) => {
        this.registrador.error(`Erro ao buscar transações para recuperação: ${erro.message}`);
        throw erro;
      }
    );
  }

  async marcarComoProcessando(transacaoId) {
    return this.atualizarStatusTransacao(transacaoId, 'processando', 'Processamento iniciado');
  }

  async adicionarRespostaTransacao(transacaoId, resposta) {
    const resultado = await this.repoTransacoes.adicionarResposta(transacaoId, resposta);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          this.registrador.warn(`Transação ${transacaoId} não encontrada para adicionar resposta`);
          return false;
        }
        
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao adicionar resposta à transação: ${erro.message}`);
        throw erro;
      }
    );
  }

  /**
 * Marca uma transação como entregue e a remove do banco de dados
 * @param {string} transacaoId - ID da transação
 * @returns {Promise<boolean>} Verdadeiro se operação bem-sucedida
 */
  async marcarComoEntregue(transacaoId) {
    // Refatorado: Usa atualizarStatusTransacao e removerTransacaoPorId, tratando Resultado
    const resultadoAtualizacao = await this.atualizarStatusTransacao(
      transacaoId,
      'entregue',
      'Mensagem entregue com sucesso'
    );

    // Se a atualização falhar (ex: transação não encontrada), retorna falha
    if (!resultadoAtualizacao) { // atualizarStatusTransacao retorna boolean
        this.registrador.warn(`Falha ao atualizar status para 'entregue' na transação ${transacaoId}. Não será removida.`);
        return false; // Indica falha na operação completa
    }

    // Se a atualização foi bem-sucedida, tenta remover
    const resultadoRemocao = await this.repoTransacoes.removerTransacaoPorId(transacaoId);

    // Dobra o resultado da remoção para logar e retornar boolean
    return Resultado.dobrar(
      resultadoRemocao,
      (numRemovidos) => {
        if (numRemovidos > 0) {
          this.registrador.info(`Transação ${transacaoId} marcada como entregue e removida.`);
          return true;
        } else {
          // Isso não deveria acontecer se a atualização funcionou, mas logamos por segurança
          this.registrador.warn(`Transação ${transacaoId} atualizada para 'entregue', mas não encontrada para remoção.`);
          return false; // Considera falha se não removeu após atualizar
        }
      },
      (erro) => {
        this.registrador.error(`Erro ao remover transação ${transacaoId} após marcar como entregue: ${erro.message}`);
        // Mesmo que a remoção falhe, a transação foi marcada como entregue,
        // então podemos considerar a operação principal como parcialmente sucedida,
        // mas retornamos false para indicar que algo inesperado ocorreu.
        return false;
      }
    );
  }

  async registrarFalhaEntrega(transacaoId, erro) {
    // Garantir que erro seja uma string
    const erroString = String(erro);

    const resultado = await this.repoTransacoes.registrarFalhaEntrega(transacaoId, erroString);

    return Resultado.dobrar(
      resultado,
      () => {
        this.registrador.warn(`Falha registrada para transação ${transacaoId}: ${erroString}`);
        return true;
      },
      (erroOperacao) => {
        // PROTEÇÃO: Usar String(erroOperacao) em vez de acessar .message
        this.registrador.error(`Erro ao registrar falha: ${String(erroOperacao)}`);
        throw erroOperacao;
      }
    );
  }

  async atualizarStatusTransacao(transacaoId, status, detalhes) {
    const resultado = await this.repoTransacoes.atualizarStatus(transacaoId, status, detalhes);

    return Resultado.dobrar(
      resultado,
      (infoAtualizacao) => {
        if (infoAtualizacao.numAfetados === 0) {
          this.registrador.warn(`Transação ${transacaoId} não encontrada para atualização`);
          return false;
        }
        
        return true;
      },
      (erro) => {
        this.registrador.error(`Erro ao atualizar status da transação: ${erro.message}`);
        throw erro;
      }
    );
  }

  async processarTransacoesPendentes(clienteWhatsApp) {
    // Refatorado: Busca primeiro, depois processa iterativamente.
    if (!clienteWhatsApp) {
      this.registrador.error('Cliente WhatsApp não fornecido para processamento de transações');
      // Retorna um Resultado.falha em vez de lançar erro diretamente
      return Resultado.falha(new Error('Cliente WhatsApp é necessário para processar transações'));
    }

    const resultadoBusca = await this.repoTransacoes.buscarTransacoesIncompletas();

    if (!resultadoBusca.sucesso) {
      this.registrador.error(`Erro ao buscar transações pendentes para processamento: ${resultadoBusca.erro.message}`);
      return Resultado.falha(resultadoBusca.erro); // Propaga o erro da busca
    }

    const transacoesPendentes = resultadoBusca.dados;

    if (!transacoesPendentes || transacoesPendentes.length === 0) {
      this.registrador.debug('Nenhuma transação pendente encontrada para processamento.');
      return Resultado.sucesso(0); // Sucesso, 0 processadas
    }

    this.registrador.info(`Encontradas ${transacoesPendentes.length} transações pendentes para processamento.`);
    let processadasComSucesso = 0;
    let falhasNoProcessamento = 0;

    // Função interna de processamento (mantida similar)
    const processarTransacaoIndividual = async (transacao) => {
       if (!transacao || !transacao.id) {
         this.registrador.warn('Transação inválida encontrada no processamento');
         return false;
       }
       if (!transacao.resposta) {
         this.registrador.warn(`Transação ${transacao.id} sem resposta para reenviar`);
         // Considerar marcar como falha permanente ou investigar? Por ora, apenas ignora.
         return false;
       }
       if (!transacao.chatId) {
         this.registrador.warn(`Transação ${transacao.id} sem chatId definido`);
         // Marcar como falha?
         await this.registrarFalhaEntrega(transacao.id, 'Chat ID não definido na transação pendente.');
         return false;
       }

       try {
         await clienteWhatsApp.enviarMensagem(transacao.chatId, transacao.resposta);
         await this.marcarComoEntregue(transacao.id); // Usa o método já refatorado
         this.registrador.info(`Transação ${transacao.id} reprocessada e marcada como entregue.`);
         return true;
       } catch (erro) {
         const mensagemErro = String(erro);
         this.registrador.error(`Erro ao reprocessar transação ${transacao.id}: ${mensagemErro}`);
         await this.registrarFalhaEntrega(transacao.id, `Erro no reprocessamento: ${mensagemErro}`);
         return false;
       }
    };

    // Itera sobre as transações pendentes e processa
    for (const transacao of transacoesPendentes) {
      const sucesso = await processarTransacaoIndividual(transacao);
      if (sucesso) {
        processadasComSucesso++;
      } else {
        falhasNoProcessamento++;
      }
    }

    this.registrador.info(`Processamento de transações pendentes concluído. Sucesso: ${processadasComSucesso}, Falhas: ${falhasNoProcessamento}.`);
    // Retorna sucesso com o número de transações processadas com sucesso
    return Resultado.sucesso(processadasComSucesso);
  }


  async limparTransacoesAntigas(diasRetencao = 7) {
    const resultado = await this.repoTransacoes.limparTransacoesAntigas(diasRetencao);

    return Resultado.dobrar(
      resultado,
      (numRemovidas) => numRemovidas,
      (erro) => {
        this.registrador.error(`Erro ao limpar transações antigas: ${erro.message}`);
        throw erro;
      }
    );
  }

  async obterEstatisticas() {
    const resultado = await this.repoTransacoes.obterEstatisticas();

    return Resultado.dobrar(
      resultado,
      (estatisticas) => estatisticas,
      (erro) => {
        this.registrador.error(`Erro ao obter estatísticas de transações: ${erro.message}`);
        throw erro;
      }
    );
  }

  async obterTransacao(transacaoId) {
    // Refatorado: Usa buscarTransacaoPorId da interface
    const resultado = await this.repoTransacoes.buscarTransacaoPorId(transacaoId);

    return Resultado.dobrar(
      resultado,
      (transacao) => transacao,
      (erro) => {
        this.registrador.error(`Erro ao buscar transação ${transacaoId}: ${erro.message}`);
        throw erro;
      }
    );
  }
}

module.exports = GerenciadorTransacoes;
