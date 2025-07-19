/**
 * GerenciadorNotificacoes - Módulo para gerenciar notificações pendentes
 * 
 * Implementação seguindo o padrão Ferrovia para tratamento funcional de erros.
 */

const fs = require('fs');
const path = require('path');
const _ = require('lodash/fp');
const { Resultado, ArquivoUtils, Trilho, Operacoes } = require('../../utilitarios/Ferrovia');
const { criarDiretorio, salvarArquivoJson, listarArquivos, lerArquivoJson, removerArquivo } = ArquivoUtils;

class GerenciadorNotificacoes {
  /**
   * Cria uma instância do gerenciador de notificações
   * @param {Object} registrador - Objeto logger para registro de eventos
   * @param {string} diretorioTemp - Diretório para armazenar notificações
   */
  constructor(registrador, diretorioTemp = '../temp') {
    this.registrador = registrador;
    this.diretorioTemp = diretorioTemp;

    // Garantir que o diretório exista ao inicializar
    criarDiretorio(this.diretorioTemp)
      .then(resultado => {
        if (resultado.sucesso) {
          this.registrador.info(`[Notif] Diretório pronto: ${this.diretorioTemp}`); // Simplificado
        } else {
          this.registrador.error(`[Notif] Erro ao criar diretório: ${resultado.erro.message}`); // Simplificado
        }
      });
  }

  /**
   * Salva uma notificação para ser entregue posteriormente
   * @param {string} destinatario - ID do destinatário
   * @param {string} mensagem - Texto da mensagem
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async salvar(destinatario, mensagem) {
    // Gerar nome de arquivo com base no destinatário e timestamp
    const nomeArquivo = `notificacao_${destinatario.replace(/[^0-9]/g, '')}_${Date.now()}.json`;
    const arquivoNotificacao = path.join(this.diretorioTemp, nomeArquivo);
    const registrador = this.registrador;

    // Dados da notificação
    const dadosNotificacao = {
      senderNumber: destinatario,
      message: mensagem,
      timestamp: Date.now()
    };
    
    // Composição funcional da operação usando o padrão Ferrovia
    return Trilho.encadear(
      // Criar diretório se não existir
      () => criarDiretorio(this.diretorioTemp),
      
      // Salvar arquivo JSON
      () => salvarArquivoJson(arquivoNotificacao, dadosNotificacao),
      
      // Registrar sucesso e retornar caminho
      (caminho) => {
        registrador.info(`[Notif] Notificação salva: ${caminho}`); // Simplificado
        return Resultado.sucesso(caminho);
      }
    )()
    .catch(erro => {
      registrador.error(`[Notif] Erro ao salvar notificação: ${erro.message}`); // Simplificado
      return Resultado.falha(erro);
    });
  }

  /**
   * Processa notificações pendentes
   * @param {Object} cliente - Cliente WhatsApp
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async processar(cliente) {
    if (!cliente) {
      return Resultado.falha(new Error("Cliente não fornecido para processamento de notificações"));
    }

    const registrador = this.registrador;
    const diretorioTemp = this.diretorioTemp;
    
    // Pipeline de processamento utilizando lodash/fp e o padrão Ferrovia
    return Trilho.encadear(
      // Listar arquivos no diretório
      () => listarArquivos(diretorioTemp),
      
      // Filtrar apenas arquivos de notificação
      (arquivos) => Resultado.sucesso(
        _.filter(arquivo => arquivo.startsWith('notificacao_') && arquivo.endsWith('.json'), arquivos)
      ),
      
      // Processar cada notificação e contar resultados
      async (notificacoes) => {
        if (notificacoes.length === 0) {
          return Resultado.sucesso(0);
        }
        
        registrador.info(`[Notif] Encontradas ${notificacoes.length} notificações pendentes.`); // Simplificado
        let processadas = 0;
        
        // Processamento sequencial para evitar sobrecarga
        for (const arquivo of notificacoes) {
          const resultado = await this._processarNotificacao(arquivo, cliente);
          if (resultado.sucesso && resultado.dados) {
            processadas++;
          }
        }
        
        if (processadas > 0) {
          registrador.info(`[Notif] Processadas ${processadas} notificações pendentes.`); // Simplificado
        }
        
        return Resultado.sucesso(processadas);
      }
    )()
    .catch(erro => {
      registrador.error(`[Notif] Erro ao processar notificações pendentes: ${erro.message}`); // Simplificado
      return Resultado.sucesso(0); // Falhas não críticas retornam 0 processadas
    });
  }
  
  /**
   * Método privado para processar uma notificação individual
   * @param {string} nomeArquivo - Nome do arquivo de notificação
   * @param {Object} cliente - Cliente WhatsApp
   * @returns {Promise<Resultado>} Resultado do processamento
   * @private
   */
  async _processarNotificacao(nomeArquivo, cliente) {
    const caminhoArquivo = path.join(this.diretorioTemp, nomeArquivo);
    const registrador = this.registrador;
    
    return Trilho.encadear(
      // Verificar idade do arquivo (ignorar muito recentes)
      async () => {
        const stats = await fs.promises.stat(caminhoArquivo).catch(() => null);
        if (!stats || (Date.now() - stats.mtime.getTime() < 5000)) {
          return Resultado.falha(new Error("Arquivo muito recente, ignorando"));
        }
        return Resultado.sucesso(caminhoArquivo);
      },
      
      // Ler conteúdo do arquivo
      () => lerArquivoJson(caminhoArquivo),
      
      // Enviar a mensagem
      async (dados) => {
        // Validação dos dados necessários
        if (!dados.senderNumber || !dados.message) {
          return Resultado.falha(new Error("Dados de notificação incompletos"));
        }
        
        // Enviando mensagem
        try {
          await cliente.sendMessage(dados.senderNumber, dados.message);
          registrador.info(`[Notif] ✅ Notificação pendente enviada.`); // Removido senderNumber
          
          // Remover arquivo após processamento
          await removerArquivo(caminhoArquivo);
          return Resultado.sucesso(true);
        } catch (erroEnvio) {
          return Resultado.falha(erroEnvio);
        }
      }
    )()
    .catch(erro => {
      // Ignorar erros de arquivos recentes
      // Usar includes() para tornar a verificação mais robusta
      if (erro.message?.includes("Arquivo muito recente")) {
        return Resultado.sucesso(false);
      }
      
      registrador.error(`[Notif] Erro ao processar arquivo ${nomeArquivo}: ${erro.message}`); // Simplificado
      return Resultado.sucesso(false);
    });
  }

  /**
   * Limpa notificações antigas
   * @param {number} diasAntiguidade - Dias para considerar uma notificação antiga
   * @returns {Promise<Resultado>} Número de notificações limpas
   */
  async limparAntigas(diasAntiguidade = 7) {
    const registrador = this.registrador;
    const diretorioTemp = this.diretorioTemp;
    const limiteAntiguidade = Date.now() - (diasAntiguidade * 24 * 60 * 60 * 1000);
    
    return Trilho.encadear(
      // Listar arquivos no diretório
      () => listarArquivos(diretorioTemp),
      
      // Filtrar apenas arquivos de notificação
      (arquivos) => Resultado.sucesso(
        _.filter(arquivo => arquivo.startsWith('notificacao_') && arquivo.endsWith('.json'), arquivos)
      ),
      
      // Processar cada arquivo e remover os antigos
      async (notificacoes) => {
        let removidas = 0;
        
        for (const arquivo of notificacoes) {
          const caminhoCompleto = path.join(diretorioTemp, arquivo);
          
          try {
            const stats = await fs.promises.stat(caminhoCompleto);
            if (stats.mtimeMs < limiteAntiguidade) {
              const resultado = await removerArquivo(caminhoCompleto);
              if (resultado.sucesso) {
                removidas++;
              }
            }
          } catch (err) {
            registrador.error(`Erro ao limpar notificação antiga ${arquivo}: ${err.message}`);
          }
        }
        
        if (removidas > 0) {
          registrador.info(`[Notif] Removidas ${removidas} notificações antigas.`); // Simplificado
        }
        
        return Resultado.sucesso(removidas);
      }
    )()
    .catch(erro => {
      registrador.error(`[Notif] Erro ao limpar notificações antigas: ${erro.message}`); // Simplificado
      return Resultado.sucesso(0);
    });
  }
}

module.exports = GerenciadorNotificacoes;
