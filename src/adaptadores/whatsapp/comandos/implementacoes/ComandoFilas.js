/**
 * ComandoFilas - Implementação do comando filas para gerenciar filas de processamento
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoFilas = (dependencias) => {
  const { registrador, servicoMensagem, filasMidia } = dependencias;
  
  // Verificar se usuário é administrador (simplificado nesta versão)
  const verificarPermissaoAdmin = () => {
    // Em uma implementação real, verificaria permissões
    // Por enquanto, retornamos true para simplicidade
    return Resultado.sucesso(true);
  };
  
  // Tratar subcomando limpar
  const tratarLimpar = (mensagem, args) => {
    const tipoFila = args[0];
    
    if (!tipoFila) {
      return Trilho.dePromise(servicoMensagem.enviarResposta(
        mensagem, 
        'Especifique o tipo de fila para limpar: todas, video ou imagem'
      ))
      .then(() => Resultado.sucesso(false));
    }
    
    // Opção para limpar tudo ou apenas trabalhos completos
    const apenasCompletos = args[1] !== 'tudo';
    const avisoLimpeza = apenasCompletos
      ? 'Limpando apenas trabalhos concluídos e falhas...'
      : '⚠️ ATENÇÃO: Isso vai limpar TODAS as filas, incluindo trabalhos em andamento!';
    
    return Trilho.encadear(
      // Enviar aviso
      () => Trilho.dePromise(servicoMensagem.enviarResposta(mensagem, avisoLimpeza)),
      
      // Executar limpeza
      () => Trilho.dePromise(filasMidia.limparFilas(apenasCompletos)),
      
      // Enviar resultado
      resultado => Trilho.dePromise(servicoMensagem.enviarResposta(
        mensagem, 
        `✅ Limpeza concluída!\n${JSON.stringify(resultado, null, 2)}`
      ))
    )();
  };
  
  // Função principal
  const executar = (mensagem, args, chatId) => {
    return Trilho.encadear(
      // Verificar permissão
      verificarPermissaoAdmin,
      
      ehAdmin => {
        if (!ehAdmin) {
          return Trilho.dePromise(servicoMensagem.enviarResposta(
            mensagem, 
            '❌ Desculpe, apenas administradores podem gerenciar as filas.'
          ))
          .then(() => Resultado.sucesso(false));
        }
        
        const [subcomando, ...restoArgs] = args;
        
        // Pattern matching funcional
        const executarSubcomando = _.cond([
          [_.matches('limpar'), () => tratarLimpar(mensagem, restoArgs)],
          [_.stubTrue, () => Trilho.dePromise(servicoMensagem.enviarResposta(
            mensagem, 
            `Comando de filas desconhecido. Use:
    .filas status - Mostra status das filas
    .filas limpar [tudo] - Limpa filas (use 'tudo' para limpar mesmo trabalhos em andamento)`
          ))
          .then(() => Resultado.sucesso(false))]
        ]);
        
        return executarSubcomando(subcomando);
      }
    )()
    .catch(erro => {
      registrador.error(`Erro ao processar comando filas: ${erro.message}`);
      return Resultado.falha(erro);
    });
  };
  
  return criarComando(
    'filas', 
    'Gerencia filas de processamento de mídia', 
    executar
  );
};

module.exports = criarComandoFilas;