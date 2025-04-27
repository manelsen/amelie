/**
 * CacheMensagens - Gerenciamento de cache para deduplicação de mensagens
 */
const _ = require('lodash/fp');

const criarGerenciadorCache = (registrador) => {
  // Cache para deduplicação de mensagens
  const mensagensProcessadas = new Map();

  // Limpa mensagens antigas do cache periodicamente
  const limparCacheMensagensAntigas = () => {
    const agora = Date.now();
    
    // Remover mensagens processadas há mais de 15 minutos
    const idsAntigos = Array.from(mensagensProcessadas.entries())
      .filter(([_, timestamp]) => agora - timestamp > 15 * 60 * 1000)
      .map(([id, _]) => id);
      
    // Remover todos de uma vez
    if (idsAntigos.length > 0) {
      registrador.info('CacheMensagens: Limpeza de cache iniciada', mensagensProcessadas.size);
      registrador.info('CacheMensagens: Mensagens antigas removidas', idsAntigos.length);
      idsAntigos.forEach(id => mensagensProcessadas.delete(id));
    }
  };

  // Configurar limpeza periódica
  const iniciar = () => {
    registrador.info('CacheMensagens: Limpeza de cache agendada a cada 30 minutos');
    const intervaloLimpeza = 5 * 60 * 1000; // 5 minutos
    setInterval(limparCacheMensagensAntigas, intervaloLimpeza);
    
  };

  return {
    cache: mensagensProcessadas,
    iniciar,
    limparCacheMensagensAntigas
  };
};

module.exports = criarGerenciadorCache;