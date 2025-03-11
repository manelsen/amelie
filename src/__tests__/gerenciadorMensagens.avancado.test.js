// src/__tests__/GerenciadorMensagens.avancado.test.js

const criarGerenciadorMensagens = require('../adaptadores/whatsapp/GerenciadorMensagensV2');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Mocks mais sofisticados
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue('{"data": "test"}'),
    unlink: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn().mockResolvedValue({ size: 1024, mtimeMs: Date.now() })
  },
  existsSync: jest.fn().mockReturnValue(true),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn()
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomBytes: jest.fn().mockReturnValue({ toString: () => '1234abcd' }),
  createHash: jest.fn().mockReturnValue({ 
    update: jest.fn().mockReturnThis(), 
    digest: jest.fn().mockReturnValue('hash_simulado') 
  })
}));

// Criação de mocks avançados com comportamentos condicionais
const criarMockLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  level: 'debug'
});

const criarMockClienteWhatsApp = () => {
  const cliente = new EventEmitter();
  cliente.cliente = {
    info: { wid: { _serialized: 'bot-id@c.us' } },
    getContactById: jest.fn().mockImplementation(async (id) => ({
      pushname: `Nome_${id.split('@')[0]}`,
      name: `Nome_${id.split('@')[0]}`,
      shortName: `N_${id.split('@')[0]}`,
      id: { user: id.split('@')[0] }
    })),
    getMessageById: jest.fn().mockImplementation(async (id) => ({
      id: { _serialized: id },
      body: "Mensagem recuperada",
      reply: jest.fn().mockResolvedValue(true)
    })),
    sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'new-msg-id' } })
  };
  
  cliente.deveResponderNoGrupo = jest.fn().mockImplementation(async (msg, chat) => {
    // Comportamento condicional baseado em conteúdo ou metadados
    if (msg.body && msg.body.includes('ignorar')) return false;
    if (msg.body && msg.body.startsWith('.')) return true;
    if (msg.hasQuotedMsg) return true;
    return false;
  });
  
  cliente.enviarMensagem = jest.fn().mockImplementation(async (para, conteudo, opcoes) => {
    // Simular falhas intermitentes para testar resiliência
    if (para.includes('fail')) {
      throw new Error('Falha simulada no envio');
    }
    
    // Simular uma mensagem com ID
    return { id: { _serialized: `sent-${Date.now()}` } };
  });
  
  cliente.obterHistoricoMensagens = jest.fn().mockImplementation(async (chatId) => {
    if (chatId.includes('empty')) return [];
    if (chatId.includes('large')) {
      // Histórico grande para testar performance
      return Array(100).fill(0).map((_, i) => `Usuario${i % 5}: Mensagem histórica ${i}`);
    }
    return [
      'Usuario1: Mensagem anterior 1',
      'Bot: Resposta anterior 1',
      'Usuario2: Pergunta complexa',
      'Bot: Resposta detalhada sobre o assunto'
    ];
  });
  
  cliente.pronto = true;
  cliente.reiniciarCompleto = jest.fn().mockResolvedValue(true);
  cliente.reconectar = jest.fn().mockResolvedValue(true);
  cliente.processarNotificacoesPendentes = jest.fn().mockResolvedValue(2);
  cliente.salvarNotificacaoPendente = jest.fn().mockResolvedValue(true);
  
  return cliente;
};

const criarMockGerenciadorConfig = () => {
  // Utilizando um map para armazenar configurações por chat
  const configStore = new Map();
  const promptStore = new Map();
  
  const getConfig = async (chatId) => {
    if (!configStore.has(chatId)) {
      // Configuração padrão
      configStore.set(chatId, {
        temperature: 0.9,
        topK: 1,
        topP: 0.95,
        maxOutputTokens: 1024,
        mediaImage: true,
        mediaAudio: true,
        mediaVideo: true,
        modoDescricao: 'curto',
        systemInstructions: "Instruções padrão do sistema"
      });
    }
    return configStore.get(chatId);
  };
  
  return {
    obterConfig: jest.fn().mockImplementation(getConfig),
    
    definirConfig: jest.fn().mockImplementation(async (chatId, param, valor) => {
      const config = await getConfig(chatId);
      config[param] = valor;
      configStore.set(chatId, config);
      return true;
    }),
    
    resetarConfig: jest.fn().mockImplementation(async (chatId) => {
      configStore.set(chatId, {
        temperature: 0.9,
        topK: 1,
        topP: 0.95,
        maxOutputTokens: 1024,
        mediaImage: true,
        mediaAudio: true,
        mediaVideo: true,
        modoDescricao: 'curto',
        activePrompt: null
      });
      return true;
    }),
    
    obterPromptSistema: jest.fn().mockImplementation(async (chatId, nome) => {
      const key = `${chatId}:${nome}`;
      if (!promptStore.has(key)) {
        return null;
      }
      return promptStore.get(key);
    }),
    
    listarPromptsSistema: jest.fn().mockImplementation(async (chatId) => {
      const prompts = [];
      promptStore.forEach((value, key) => {
        if (key.startsWith(`${chatId}:`)) {
          prompts.push({ name: key.split(':')[1], text: value.text });
        }
      });
      return prompts;
    }),
    
    definirPromptSistema: jest.fn().mockImplementation(async (chatId, nome, texto) => {
      promptStore.set(`${chatId}:${nome}`, { name: nome, text: texto });
      return true;
    }),
    
    definirPromptSistemaAtivo: jest.fn().mockImplementation(async (chatId, nome) => {
      const config = await getConfig(chatId);
      config.activePrompt = nome;
      configStore.set(chatId, config);
      return true;
    }),
    
    limparPromptSistemaAtivo: jest.fn().mockImplementation(async (chatId) => {
      const config = await getConfig(chatId);
      config.activePrompt = null;
      configStore.set(chatId, config);
      return true;
    }),
    
    excluirPromptSistema: jest.fn().mockImplementation(async (chatId, nome) => {
      return promptStore.delete(`${chatId}:${nome}`);
    }),
    
    obterOuCriarUsuario: jest.fn().mockImplementation(async (remetente, cliente) => {
      const userId = remetente.split('@')[0];
      return {
        id: remetente,
        name: `Usuario_${userId}`,
        joinedAt: new Date()
      };
    }),
    
    obterOuCriarGrupo: jest.fn().mockImplementation(async (chat) => {
      return {
        id: chat.id._serialized,
        title: chat.name || 'Grupo sem nome',
        createdAt: new Date()
      };
    })
  };
};

const criarMockGerenciadorAI = () => {
  // Diferentes comportamentos baseados em entradas
  const processarTexto = jest.fn().mockImplementation(async (texto, config) => {
    if (texto.includes('erro')) {
      throw new Error('Erro simulado na IA');
    }
    
    if (texto.includes('timeout')) {
      await new Promise(resolve => setTimeout(resolve, 50)); // Simulação de timeout
      throw new Error('Timeout da API Gemini');
    }
    
    if (texto.includes('longo')) {
      return 'Esta é uma resposta muito longa e detalhada que contém muitas informações. '.repeat(20);
    }
    
    return `Resposta para: "${texto.substring(0, 50)}..." [temp=${config.temperature}]`;
  });
  
  return {
    processarTexto,
    
    processarImagem: jest.fn().mockImplementation(async (imagemData, prompt, config) => {
      if (imagemData.data.includes('erro')) {
        throw new Error('Erro ao processar imagem');
      }
      
      if (config.modoDescricao === 'longo') {
        return 'Esta é uma descrição muito detalhada da imagem. '.repeat(10);
      } else {
        return 'Imagem mostra uma pessoa em pé próxima a uma árvore.';
      }
    }),
    
    processarAudio: jest.fn().mockImplementation(async (audioData, audioId, config) => {
      if (audioData.data.includes('erro')) {
        throw new Error('Erro ao processar áudio');
      }
      
      if (audioData.data.includes('bloqueado')) {
        throw new Error('SAFETY: Este conteúdo foi bloqueado por políticas de segurança');
      }
      
      return 'Transcrição do áudio: "Esta é uma mensagem de teste gravada para fins de demonstração."';
    }),
    
    processarVideo: jest.fn().mockImplementation(async (caminhoVideo, prompt, config) => {
      if (caminhoVideo.includes('erro')) {
        throw new Error('Erro ao processar vídeo');
      }
      
      if (prompt.includes('curto')) {
        return 'Vídeo curto mostrando pessoas caminhando em um parque.';
      }
      
      return 'Este vídeo mostra um grupo de pessoas caminhando em um parque durante o dia. Há crianças brincando e adultos conversando. O clima parece ensolarado.';
    }),
    
    obterOuCriarModelo: jest.fn().mockImplementation(config => ({
      generateContent: jest.fn().mockResolvedValue({
        response: { 
          text: () => `Conteúdo gerado pelo modelo ${config.model || 'desconhecido'}`
        }
      })
    }))
  };
};

const criarMockFilaProcessador = (nome = 'generica') => {
  const mockFila = {
    add: jest.fn().mockImplementation(async (tipo, dados, opcoes) => {
      // Simulação de comportamentos diferentes da fila
      if (dados.chatId && dados.chatId.includes('erro-fila')) {
        throw new Error(`Erro na fila de ${nome}`);
      }
      
      // Gerar um ID de job único
      return { id: `job-${nome}-${Date.now()}` };
    }),
    
    getFormattedQueueStatus: jest.fn().mockImplementation(async () => {
      return `📊 RELATÓRIO DE STATUS DA FILA ${nome.toUpperCase()} 📊\n\nJobs ativos: 2\nJobs pendentes: 3\nJobs concluídos: 45\nJobs com falha: 2`;
    }),
    
    limparFilas: jest.fn().mockImplementation(async (apenasCompletos) => {
      if (apenasCompletos) {
        return { removidos: { completos: 10, falhas: 2 } };
      } else {
        return 'Fila completamente esvaziada!';
      }
    }),
    
    setResultCallback: jest.fn().mockImplementation(callback => {
      // Armazenar o callback para chamá-lo em testes
      mockFila._callback = callback;
    }),
    
    // Método auxiliar para testes simularem resultados da fila
    _simularResultado: async (resultado) => {
      if (mockFila._callback) {
        await mockFila._callback(resultado);
      }
    }
  };
  
  return mockFila;
};

const criarMockGerenciadorTransacoes = () => {
  const gerenciador = new EventEmitter();
  const transacoes = new Map();
  let idContador = 1;
  
  // Gera IDs previsíveis para testes
  const gerarId = () => `tx-${(idContador++).toString().padStart(3, '0')}`;
  
  gerenciador.criarTransacao = jest.fn().mockImplementation(async (mensagem, chat) => {
    const id = gerarId();
    const transacao = {
      id,
      messageId: mensagem.id._serialized,
      chatId: chat.id._serialized,
      from: mensagem.from,
      dataCriacao: new Date(),
      ultimaAtualizacao: new Date(),
      tipo: mensagem.hasMedia ? mensagem.type : 'texto',
      status: 'criada',
      tentativas: 0,
      historico: [{
        data: new Date(),
        status: 'criada',
        detalhes: 'Transação criada'
      }]
    };
    
    transacoes.set(id, transacao);
    return transacao;
  });
  
  gerenciador.adicionarDadosRecuperacao = jest.fn().mockImplementation(async (id, dados) => {
    if (!transacoes.has(id)) return { numAfetados: 0 };
    
    const transacao = transacoes.get(id);
    transacao.dadosRecuperacao = dados;
    transacao.ultimaAtualizacao = new Date();
    transacao.historico.push({
      data: new Date(),
      status: 'dados_recuperacao',
      detalhes: 'Dados de recuperação adicionados'
    });
    
    return { numAfetados: 1 };
  });
  
  gerenciador.marcarComoProcessando = jest.fn().mockImplementation(async (id) => {
    if (!transacoes.has(id)) return { numAfetados: 0 };
    
    const transacao = transacoes.get(id);
    transacao.status = 'processando';
    transacao.ultimaAtualizacao = new Date();
    transacao.historico.push({
      data: new Date(),
      status: 'processando',
      detalhes: 'Processamento iniciado'
    });
    
    return { numAfetados: 1 };
  });
  
  gerenciador.adicionarRespostaTransacao = jest.fn().mockImplementation(async (id, resposta) => {
    if (!transacoes.has(id)) return { numAfetados: 0 };
    
    const transacao = transacoes.get(id);
    transacao.resposta = resposta;
    transacao.ultimaAtualizacao = new Date();
    transacao.historico.push({
      data: new Date(),
      status: 'resposta_gerada',
      detalhes: 'Resposta gerada pela IA'
    });
    
    return { numAfetados: 1 };
  });
  
  gerenciador.marcarComoEntregue = jest.fn().mockImplementation(async (id) => {
    if (!transacoes.has(id)) return { numAfetados: 0 };
    
    const transacao = transacoes.get(id);
    transacao.status = 'entregue';
    transacao.ultimaAtualizacao = new Date();
    transacao.historico.push({
      data: new Date(),
      status: 'entregue',
      detalhes: 'Mensagem entregue com sucesso'
    });
    
    // Simular remoção após entrega
    transacoes.delete(id);
    return { numAfetados: 1 };
  });
  
  gerenciador.registrarFalhaEntrega = jest.fn().mockImplementation(async (id, erro) => {
    if (!transacoes.has(id)) return { numAfetados: 0 };
    
    const transacao = transacoes.get(id);
    transacao.tentativas = (transacao.tentativas || 0) + 1;
    transacao.status = transacao.tentativas >= 3 ? 'falha_permanente' : 'falha_temporaria';
    transacao.ultimaAtualizacao = new Date();
    transacao.ultimoErro = erro;
    transacao.historico.push({
      data: new Date(),
      status: transacao.status,
      detalhes: `Falha na entrega: ${erro}`
    });
    
    return { numAfetados: 1 };
  });
  
  gerenciador.recuperarTransacoesIncompletas = jest.fn().mockResolvedValue(0);
  
  gerenciador.buscarTransacoesIncompletas = jest.fn().mockImplementation(async () => {
    const incompletas = [];
    transacoes.forEach(tx => {
      if (['processando', 'resposta_gerada', 'falha_temporaria'].includes(tx.status) && 
          tx.resposta && tx.dadosRecuperacao) {
        incompletas.push(tx);
      }
    });
    return incompletas;
  });
  
  gerenciador.obterTransacao = jest.fn().mockImplementation(async (id) => {
    return transacoes.get(id) || null;
  });
  
  return gerenciador;
};

const criarMockServicoMensagem = () => {
  // Track message history for testing
  const historico = [];
  
  return {
    enviarResposta: jest.fn().mockImplementation(async (mensagem, texto, transacaoId) => {
      if (mensagem && mensagem.id && mensagem.id._serialized && mensagem.id._serialized.includes('falha')) {
        throw new Error('Erro simulado ao enviar resposta');
      }
      
      // Registrar tentativa para testes
      historico.push({
        para: mensagem?.from || 'desconhecido',
        texto,
        transacaoId,
        timestamp: Date.now()
      });
      
      return true;
    }),
    
    capturarSnapshotMensagem: jest.fn().mockImplementation(async (msg) => {
      if (!msg || !msg.id) return null;
      
      return {
        id: msg.id._serialized,
        body: msg.body || '',
        tipo: msg.type || 'texto',
        data: new Date().toISOString(),
        remetente: {
          id: msg.author || msg.from,
          nome: 'Usuário Teste'
        },
        chat: {
          id: msg.from || 'chat-desconhecido',
          tipo: msg.from && msg.from.includes('@g.us') ? 'grupo' : 'individual',
          nome: 'Chat de Teste'
        },
        temMidia: msg.hasMedia || false,
        tipoMidia: msg.hasMedia ? (msg.type || 'desconhecido') : null,
        timestampSnapshot: Date.now()
      };
    }),
    
    gerarTextoContexto: jest.fn().mockImplementation((snapshot) => {
      if (!snapshot) return '';
      
      if (snapshot.temMidia) {
        const descricaoMidia = snapshot.tipoMidia === 'image' ? '📷 [Imagem]' : 
                              snapshot.tipoMidia === 'video' ? '🎥 [Vídeo]' :
                              snapshot.tipoMidia === 'audio' ? '🔊 [Áudio]' : '[Mídia]';
        return `📩 Em resposta a ${descricaoMidia} de ${snapshot.remetente.nome}`;
      }
      
      return `📩 Em resposta a ${snapshot.remetente.nome}: "${snapshot.body.substring(0, 50)}${snapshot.body.length > 50 ? '...' : ''}"`;
    }),
    
    Resultado: {
      sucesso: (dados) => ({ sucesso: true, dados, erro: null }),
      falha: (erro) => ({ sucesso: false, dados: null, erro })
    },
    
    // Helper para testes
    getHistorico: () => [...historico]
  };
};

// Funções avançadas de mock para mensagens
const criarMockMensagem = (opcoes = {}) => {
  const defaults = {
    id: { _serialized: `msg-${Date.now()}` },
    from: 'sender@c.us',
    author: 'sender@c.us',
    body: 'Mensagem padrão',
    hasMedia: false,
    type: 'chat',
    timestamp: Date.now(),
    _data: {
      id: `stanza-${Date.now()}`,
      notifyName: 'Nome do Remetente'
    },
    hasQuotedMsg: false
  };
  
  const mensagem = { ...defaults, ...opcoes };
  
  // Adicionar métodos
  mensagem.reply = jest.fn().mockImplementation(async (texto) => {
    if (mensagem.id._serialized.includes('falha')) {
      throw new Error('Falha simulada no reply');
    }
    return { id: { _serialized: `reply-${Date.now()}` } };
  });
  
  mensagem.getChat = jest.fn().mockImplementation(async () => {
    const isGroup = mensagem.from && mensagem.from.includes('@g.us');
    
    return {
      id: { _serialized: mensagem.from },
      sendSeen: jest.fn().mockResolvedValue(true),
      isGroup,
      name: isGroup ? 'Grupo de Teste' : 'Chat Individual',
      participants: isGroup ? [
        { id: { _serialized: 'participante1@c.us', user: 'participante1' } },
        { id: { _serialized: 'participante2@c.us', user: 'participante2' } },
        { id: { _serialized: 'bot-id@c.us', user: 'bot-id' } }
      ] : [],
      sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: `sent-${Date.now()}` } })
    };
  });
  
  mensagem.getMentions = jest.fn().mockImplementation(async () => {
    if (mensagem.body && mensagem.body.includes('@bot')) {
      return [{ id: { _serialized: 'bot-id@c.us' } }];
    }
    return [];
  });
  
  mensagem.getQuotedMessage = jest.fn().mockImplementation(async () => {
    if (!mensagem.hasQuotedMsg) return null;
    
    return {
      id: { _serialized: `quoted-${Date.now()}` },
      body: 'Mensagem citada para teste',
      fromMe: mensagem._data.quotedFromMe || true,
      from: mensagem.from
    };
  });
  
  mensagem.downloadMedia = jest.fn().mockImplementation(async () => {
    if (!mensagem.hasMedia) {
      throw new Error('Esta mensagem não tem mídia para download');
    }
    
    // Simular diferentes tipos de mídia
    switch (mensagem.type) {
      case 'image':
        return {
          data: mensagem._data.errorMedia ? 'erro_base64data' : 'base64data_imagem',
          mimetype: 'image/jpeg'
        };
      case 'video':
        return {
          data: mensagem._data.errorMedia ? 'erro_base64data' : 'base64data_video',
          mimetype: 'video/mp4'
        };
      case 'audio':
      case 'ptt':
        return {
          data: mensagem._data.errorMedia ? 'erro_base64data' : 
                mensagem._data.blockedAudio ? 'bloqueado_base64data' : 'base64data_audio',
          mimetype: mensagem.type === 'ptt' ? 'audio/ogg; codecs=opus' : 'audio/mpeg'
        };
      default:
        return {
          data: 'base64data_unknown',
          mimetype: 'application/octet-stream'
        };
    }
  });
  
  return mensagem;
};

// Funções específicas para tipos de mensagem
const criarMockMensagemTexto = (texto = 'Mensagem de texto padrão', opcoes = {}) => {
  return criarMockMensagem({ body: texto, type: 'chat', ...opcoes });
};

const criarMockMensagemComando = (comando = 'ajuda', args = [], opcoes = {}) => {
  const textoComando = `.${comando} ${args.join(' ')}`.trim();
  return criarMockMensagem({ body: textoComando, type: 'chat', ...opcoes });
};

const criarMockMensagemImagem = (legenda = '', opcoes = {}) => {
  return criarMockMensagem({
    body: legenda,
    hasMedia: true,
    type: 'image',
    ...opcoes
  });
};

const criarMockMensagemAudio = (opcoes = {}) => {
  return criarMockMensagem({
    body: '',
    hasMedia: true,
    type: opcoes.ptt ? 'ptt' : 'audio',
    ...opcoes
  });
};

const criarMockMensagemVideo = (legenda = '', opcoes = {}) => {
  return criarMockMensagem({
    body: legenda,
    hasMedia: true,
    type: 'video',
    ...opcoes
  });
};

const criarMockMensagemGrupo = (texto = 'Mensagem em grupo', opcoes = {}) => {
  return criarMockMensagem({
    body: texto,
    from: 'grupo-teste@g.us',
    author: 'autor@c.us',
    ...opcoes
  });
};

const criarMockNotificacaoGrupo = (tipo = 'add', opcoes = {}) => {
  const notificacao = {
    type: 'group_notification',
    recipientIds: opcoes.recipientIds || ['bot-id@c.us', 'usuario1@c.us'],
    getChat: jest.fn().mockResolvedValue({
      id: { _serialized: 'grupo-teste@g.us' },
      name: 'Grupo de Teste',
      isGroup: true,
      sendMessage: jest.fn().mockResolvedValue(true)
    }),
    ...opcoes
  };
  
  return notificacao;
};

// Suíte de testes avançada
describe('GerenciadorMensagens - Testes Avançados', () => {
  let gerenciadorMensagens;
  let dependencias;
  
  beforeEach(() => {
    // Preparar dependências com mocks avançados
    dependencias = {
      registrador: criarMockLogger(),
      clienteWhatsApp: criarMockClienteWhatsApp(),
      gerenciadorConfig: criarMockGerenciadorConfig(),
      gerenciadorAI: criarMockGerenciadorAI(),
      filaProcessamento: criarMockFilaProcessador('video'),
      filaProcessamentoImagem: criarMockFilaProcessador('imagem'),
      gerenciadorTransacoes: criarMockGerenciadorTransacoes(),
      servicoMensagem: criarMockServicoMensagem()
    };
    
    // Criar o gerenciador de mensagens
    gerenciadorMensagens = criarGerenciadorMensagens(dependencias);
    
    // Iniciar o gerenciador
    gerenciadorMensagens.iniciar();
    
    // Limpar mocks antes de cada teste
    jest.clearAllMocks();
  });
  
  describe('Processamento de Mensagens de Texto', () => {
    test('Deve processar uma mensagem de texto simples com sucesso', async () => {
      const mensagem = criarMockMensagemTexto('Olá, como você está?');
      
      const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
      
      expect(resultado).toBe(true);
      expect(dependencias.gerenciadorTransacoes.criarTransacao).toHaveBeenCalledTimes(1);
      expect(dependencias.gerenciadorTransacoes.adicionarDadosRecuperacao).toHaveBeenCalledTimes(1);
      expect(dependencias.gerenciadorTransacoes.marcarComoProcessando).toHaveBeenCalledTimes(1);
      expect(dependencias.gerenciadorAI.processarTexto).toHaveBeenCalledTimes(1);
      expect(dependencias.gerenciadorTransacoes.adicionarRespostaTransacao).toHaveBeenCalledTimes(1);
      expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledTimes(1);
    });
    
    test('Deve lidar com histórico vazio corretamente', async () => {
      const mensagem = criarMockMensagemTexto('Olá');
      dependencias.clienteWhatsApp.obterHistoricoMensagens.mockResolvedValueOnce([]);
      
      const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
      
      expect(resultado).toBe(true);
      expect(dependencias.gerenciadorAI.processarTexto).toHaveBeenCalled();
      // Verificar que a mensagem foi incluída mesmo sem histórico
      expect(dependencias.gerenciadorAI.processarTexto.mock.calls[0][0]).toContain('Olá');
    });
    
    test('Deve lidar com histórico grande sem problemas', async () => {
        const mensagem = criarMockMensagemTexto('Pergunta com histórico grande');
        mensagem.from = 'usuario@large.us';
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorAI.processarTexto).toHaveBeenCalled();
        // Verificar que o histórico grande foi processado
        expect(dependencias.gerenciadorAI.processarTexto.mock.calls[0][0].length).toBeGreaterThan(1000);
      });
      
      test('Deve tratar erro da IA ao processar texto', async () => {
        const mensagem = criarMockMensagemTexto('Esta mensagem causará um erro na IA');
        dependencias.gerenciadorAI.processarTexto.mockRejectedValueOnce(new Error('Erro da IA'));
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('erro'),
          expect.anything()
        );
      });
      
      test('Deve tratar timeout da IA graciosamente', async () => {
        const mensagem = criarMockMensagemTexto('Esta mensagem causará um timeout');
        dependencias.gerenciadorAI.processarTexto.mockRejectedValueOnce(new Error('Timeout da API Gemini'));
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('erro'),
          expect.anything()
        );
      });
      
      test('Deve ignorar mensagem duplicada', async () => {
        const mensagem = criarMockMensagemTexto('Mensagem única');
        
        // Primeira vez deve processar
        await gerenciadorMensagens.processarMensagem(mensagem);
        
        // Limpar mocks para verificar que não são chamados novamente
        jest.clearAllMocks();
        
        // Segunda vez deve ignorar
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.gerenciadorTransacoes.criarTransacao).not.toHaveBeenCalled();
        expect(dependencias.gerenciadorAI.processarTexto).not.toHaveBeenCalled();
      });
    });
    
    describe('Processamento de Comandos', () => {
      test('Deve processar comando .ajuda corretamente', async () => {
        const mensagem = criarMockMensagemComando('ajuda');
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('comandos'),
          expect.anything()
        );
      });
      
      test('Deve processar comando .reset corretamente', async () => {
        const mensagem = criarMockMensagemComando('reset');
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorConfig.resetarConfig).toHaveBeenCalledWith(expect.any(String));
        expect(dependencias.gerenciadorConfig.limparPromptSistemaAtivo).toHaveBeenCalledWith(expect.any(String));
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('resetadas'),
          expect.anything()
        );
      });
      
      test('Deve processar comando .prompt com subcomando set', async () => {
        const mensagem = criarMockMensagemComando('prompt', ['set', 'meuPrompt', 'Este é um prompt de teste']);
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorConfig.definirPromptSistema).toHaveBeenCalledWith(
          expect.any(String),
          'meuPrompt',
          'Este é um prompt de teste'
        );
      });
      
      test('Deve processar comando .prompt com subcomando get', async () => {
        // Preparar mock para retornar um prompt específico
        dependencias.gerenciadorConfig.obterPromptSistema.mockResolvedValueOnce({
          name: 'meuPrompt',
          text: 'Conteúdo do prompt de teste'
        });
        
        const mensagem = criarMockMensagemComando('prompt', ['get', 'meuPrompt']);
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorConfig.obterPromptSistema).toHaveBeenCalledWith(
          expect.any(String),
          'meuPrompt'
        );
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('Conteúdo do prompt de teste'),
          expect.anything()
        );
      });
      
      test('Deve processar comando .prompt com subcomando list', async () => {
        // Preparar mock para retornar lista de prompts
        dependencias.gerenciadorConfig.listarPromptsSistema.mockResolvedValueOnce([
          { name: 'prompt1', text: 'Conteúdo 1' },
          { name: 'prompt2', text: 'Conteúdo 2' }
        ]);
        
        const mensagem = criarMockMensagemComando('prompt', ['list']);
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorConfig.listarPromptsSistema).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('prompt1, prompt2'),
          expect.anything()
        );
      });
      
      test('Deve processar comando .config com subcomando set', async () => {
        const mensagem = criarMockMensagemComando('config', ['set', 'temperature', '0.8']);
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'temperature',
          0.8
        );
      });
      
      test('Deve processar comando .config com subcomando get', async () => {
        const mensagem = criarMockMensagemComando('config', ['get', 'temperature']);
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorConfig.obterConfig).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalled();
      });
      
      test('Deve processar comando .cego corretamente', async () => {
        const mensagem = criarMockMensagemComando('cego');
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'modoDescricao',
          'curto'
        );
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'mediaImage',
          true
        );
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'mediaAudio',
          false
        );
        expect(dependencias.gerenciadorConfig.definirPromptSistema).toHaveBeenCalled();
        expect(dependencias.gerenciadorConfig.definirPromptSistemaAtivo).toHaveBeenCalled();
      });
      
      test('Deve processar comandos de alternância de mídia', async () => {
        // Testar .audio
        let mensagem = criarMockMensagemComando('audio');
        await gerenciadorMensagens.processarMensagem(mensagem);
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'mediaAudio',
          false // Toggle do valor padrão true para false
        );
        
        // Reset mock
        jest.clearAllMocks();
        
        // Testar .video
        mensagem = criarMockMensagemComando('video');
        await gerenciadorMensagens.processarMensagem(mensagem);
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'mediaVideo',
          false // Toggle do valor padrão true para false
        );
        
        // Reset mock
        jest.clearAllMocks();
        
        // Testar .imagem
        mensagem = criarMockMensagemComando('imagem');
        await gerenciadorMensagens.processarMensagem(mensagem);
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'mediaImage',
          false // Toggle do valor padrão true para false
        );
      });
      
      test('Deve processar comando .longo corretamente', async () => {
        const mensagem = criarMockMensagemComando('longo');
        
        await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'modoDescricao',
          'longo'
        );
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'descricaoLonga',
          true
        );
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'descricaoCurta',
          false
        );
      });
      
      test('Deve processar comando .curto corretamente', async () => {
        const mensagem = criarMockMensagemComando('curto');
        
        await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'modoDescricao',
          'curto'
        );
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'descricaoLonga',
          false
        );
        expect(dependencias.gerenciadorConfig.definirConfig).toHaveBeenCalledWith(
          expect.any(String),
          'descricaoCurta',
          true
        );
      });
      
      test('Deve rejeitar comandos inválidos', async () => {
        const mensagem = criarMockMensagemComando('comandoinvalido');
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('desconhecido'),
          expect.anything()
        );
      });
    });
    
    describe('Processamento de Mensagens de Imagem', () => {
      test('Deve processar uma mensagem com imagem corretamente', async () => {
        const mensagem = criarMockMensagemImagem('Descreva esta imagem');
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorTransacoes.criarTransacao).toHaveBeenCalled();
        expect(dependencias.gerenciadorTransacoes.marcarComoProcessando).toHaveBeenCalled();
        expect(dependencias.filaProcessamentoImagem.add).toHaveBeenCalledWith(
          'process-image',
          expect.objectContaining({
            chatId: expect.any(String),
            userPrompt: 'Descreva esta imagem',
            modoDescricao: 'curto'
          }),
          expect.anything()
        );
      });
      
      test('Deve pular processamento de imagem quando recurso desabilitado', async () => {
        // Configurar mock para retornar mediaImage: false
        dependencias.gerenciadorConfig.obterConfig.mockResolvedValueOnce({
          mediaImage: false
        });
        
        const mensagem = criarMockMensagemImagem();
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.gerenciadorTransacoes.criarTransacao).not.toHaveBeenCalled();
        expect(dependencias.filaProcessamentoImagem.add).not.toHaveBeenCalled();
      });
      
      test('Deve tratar erros no download da imagem', async () => {
        const mensagem = criarMockMensagemImagem();
        mensagem.downloadMedia.mockRejectedValueOnce(new Error('Falha no download da mídia'));
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('erro'),
          expect.anything()
        );
      });
      
      test('Deve tratar erros de segurança no processamento de imagem', async () => {
        const mensagem = criarMockMensagemImagem('', { _data: { errorMedia: true } });
        dependencias.filaProcessamentoImagem.add.mockRejectedValueOnce(
          new Error('SAFETY: Conteúdo bloqueado por políticas de segurança')
        );
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('segurança'),
          expect.anything()
        );
      });
      
      test('Deve simular recebimento de resultado da fila de imagem', async () => {
        // Primeiro processar uma imagem
        const mensagem = criarMockMensagemImagem('Analise esta foto');
        await gerenciadorMensagens.processarMensagem(mensagem);
        
        // Capturar o ID da transação
        const transacaoId = dependencias.gerenciadorTransacoes.criarTransacao.mock.results[0].value.id;
        
        // Simular recebimento de resultado da fila
        await dependencias.filaProcessamentoImagem._simularResultado({
          resposta: 'Descrição da imagem: mostra uma paisagem montanhosa com céu azul.',
          senderNumber: mensagem.from,
          chatId: 'chat-1',
          messageId: mensagem.id._serialized,
          transacaoId
        });
        
        // Verificar que o resultado foi processado
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          expect.anything(),
          'Descrição da imagem: mostra uma paisagem montanhosa com céu azul.',
          transacaoId
        );
      });
    });
    
    describe('Processamento de Mensagens de Áudio', () => {
      test('Deve processar uma mensagem de áudio corretamente', async () => {
        const mensagem = criarMockMensagemAudio();
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorTransacoes.criarTransacao).toHaveBeenCalled();
        expect(dependencias.gerenciadorTransacoes.marcarComoProcessando).toHaveBeenCalled();
        expect(dependencias.gerenciadorAI.processarAudio).toHaveBeenCalled();
        expect(dependencias.gerenciadorTransacoes.adicionarRespostaTransacao).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalled();
      });
      
      test('Deve pular processamento de áudio quando recurso desabilitado', async () => {
        // Configurar mock para retornar mediaAudio: false
        dependencias.gerenciadorConfig.obterConfig.mockResolvedValueOnce({
          mediaAudio: false
        });
        
        const mensagem = criarMockMensagemAudio();
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.gerenciadorTransacoes.criarTransacao).not.toHaveBeenCalled();
        expect(dependencias.gerenciadorAI.processarAudio).not.toHaveBeenCalled();
      });
      
      test('Deve identificar áudio PTT (Push-to-Talk)', async () => {
        const mensagem = criarMockMensagemAudio({ ptt: true });
        
        await gerenciadorMensagens.processarMensagem(mensagem);
        
        // Verificar que o mime type do PTT foi passado ao processar
        expect(dependencias.gerenciadorAI.processarAudio).toHaveBeenCalledWith(
          expect.objectContaining({
            mimetype: 'audio/ogg; codecs=opus'
          }),
          expect.anything(),
          expect.anything()
        );
      });
      
      test('Deve rejeitar áudios muito grandes', async () => {
        const mensagemGrande = criarMockMensagemAudio();
        // Modifique o mock para retornar um áudio grande
        mensagemGrande.downloadMedia.mockResolvedValueOnce({
          data: 'a'.repeat(21 * 1024 * 1024), // 21 MB
          mimetype: 'audio/mpeg'
        });
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagemGrande);
        
        expect(resultado).toBe(false);
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagemGrande,
          expect.stringContaining('20MB'),
          expect.anything()
        );
      });
      
      test('Deve tratar conteúdo de áudio bloqueado por políticas de segurança', async () => {
        const mensagem = criarMockMensagemAudio({ _data: { blockedAudio: true } });
        dependencias.gerenciadorAI.processarAudio.mockRejectedValueOnce(
          new Error('SAFETY: Conteúdo bloqueado por políticas de segurança')
        );
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('erro'),
          expect.anything()
        );
      });
    });
    
    describe('Processamento de Mensagens de Vídeo', () => {
      beforeEach(() => {
        // Configurar mocks específicos para vídeo
        fs.promises.writeFile.mockResolvedValue(undefined);
        fs.promises.stat.mockResolvedValue({ size: 1024 });
      });
      
      test('Deve processar uma mensagem de vídeo corretamente', async () => {
        const mensagem = criarMockMensagemVideo('Descreva este vídeo');
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorTransacoes.criarTransacao).toHaveBeenCalled();
        expect(dependencias.gerenciadorTransacoes.marcarComoProcessando).toHaveBeenCalled();
        expect(fs.promises.writeFile).toHaveBeenCalled();
        expect(dependencias.filaProcessamento.add).toHaveBeenCalledWith(
          'process-video',
          expect.objectContaining({
            chatId: expect.any(String),
            userPrompt: 'Descreva este vídeo',
            modoDescricao: 'curto'
          }),
          expect.objectContaining({
            timeout: 300000 // 5 minutos
          })
        );
      });
      
      test('Deve pular processamento de vídeo quando recurso desabilitado', async () => {
        // Configurar mock para retornar mediaVideo: false
        dependencias.gerenciadorConfig.obterConfig.mockResolvedValueOnce({
          mediaVideo: false
        });
        
        const mensagem = criarMockMensagemVideo();
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.gerenciadorTransacoes.criarTransacao).not.toHaveBeenCalled();
        expect(dependencias.filaProcessamento.add).not.toHaveBeenCalled();
      });
      
      test('Deve rejeitar vídeos muito grandes', async () => {
        const mensagemGrande = criarMockMensagemVideo();
        // Modifique o mock para retornar um vídeo grande
        mensagemGrande.downloadMedia.mockResolvedValueOnce({
          data: 'a'.repeat(21 * 1024 * 1024), // 21 MB
          mimetype: 'video/mp4'
        });
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagemGrande);
        
        expect(resultado).toBe(false);
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagemGrande,
          expect.stringContaining('20MB'),
          expect.anything()
        );
      });
      
      test('Deve tratar erros ao salvar arquivo temporário', async () => {
        const mensagem = criarMockMensagemVideo();
        fs.promises.writeFile.mockRejectedValueOnce(new Error('Erro ao salvar arquivo'));
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          mensagem,
          expect.stringContaining('probleminha'),
          expect.anything()
        );
      });
      
      test('Deve tratar erro na fila de processamento', async () => {
        const mensagem = criarMockMensagemVideo();
        dependencias.filaProcessamento.add.mockRejectedValueOnce(
          new Error('Erro na fila de processamento')
        );
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalled();
      });
      
      test('Deve simular recebimento de resultado da fila de vídeo', async () => {
        // Primeiro processar um vídeo
        const mensagem = criarMockMensagemVideo('Analise este vídeo');
        await gerenciadorMensagens.processarMensagem(mensagem);
        
        // Capturar o ID da transação
        const transacaoId = dependencias.gerenciadorTransacoes.criarTransacao.mock.results[0].value.id;
        
        // Simular recebimento de resultado da fila
        await dependencias.filaProcessamento._simularResultado({
          resposta: 'Descrição do vídeo: mostra pessoas caminhando em um parque com crianças brincando.',
          senderNumber: mensagem.from,
          chatId: 'chat-1',
          messageId: mensagem.id._serialized,
          transacaoId
        });
        
        // Verificar que o resultado foi processado
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          expect.anything(),
          'Descrição do vídeo: mostra pessoas caminhando em um parque com crianças brincando.',
          transacaoId
        );
      });
    });
    
    describe('Processamento de Mensagens em Grupo', () => {
      test('Deve ignorar mensagens em grupo que não mencionam o bot', async () => {
        const mensagem = criarMockMensagemGrupo('Uma mensagem qualquer no grupo');
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.gerenciadorAI.processarTexto).not.toHaveBeenCalled();
      });
      
      test('Deve processar mensagem em grupo mencionando o bot', async () => {
        const mensagem = criarMockMensagemGrupo('Olá @bot como você está?');
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorAI.processarTexto).toHaveBeenCalled();
      });
      
      test('Deve processar mensagem em grupo respondendo ao bot', async () => {
        const mensagem = criarMockMensagemGrupo('Resposta à sua pergunta');
        mensagem.hasQuotedMsg = true;
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.gerenciadorAI.processarTexto).toHaveBeenCalled();
      });
      
      test('Deve processar comandos em grupo sem menção', async () => {
        const mensagem = criarMockMensagemComando('ajuda');
        mensagem.from = 'grupo-teste@g.us';
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(true);
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalled();
      });
    });
    
    describe('Processamento de Entrada em Grupo', () => {
      test('Deve enviar mensagem de boas-vindas quando o bot é adicionado ao grupo', async () => {
        const notificacao = criarMockNotificacaoGrupo('add');
        
        // Disparar o evento de entrada em grupo
        dependencias.clienteWhatsApp.emit('entrada_grupo', notificacao);
        
        expect(notificacao.getChat).toHaveBeenCalled();
        // Verificar que as mensagens de boas-vindas foram enviadas
        expect(notificacao.getChat().sendMessage).toHaveBeenCalledTimes(2);
      });
      
      test('Não deve enviar mensagem quando outro usuário é adicionado', async () => {
        const notificacao = criarMockNotificacaoGrupo('add', { recipientIds: ['outro-usuario@c.us'] });
        
        // Disparar o evento de entrada em grupo
        dependencias.clienteWhatsApp.emit('entrada_grupo', notificacao);
        
        expect(notificacao.getChat).not.toHaveBeenCalled();
      });
    });
    
    describe('Recuperação de Transações', () => {
      test('Deve recuperar transação interrompida', async () => {
        // Criar uma transação simulada para recuperação
        const transacao = {
          id: 'tx-recuperacao',
          resposta: 'Resposta que deve ser entregue após recuperação',
          dadosRecuperacao: {
            remetenteId: 'usuario-recuperacao@c.us',
            chatId: 'chat-recuperacao'
          }
        };
        
        // Emitir evento de transação para recuperar
        dependencias.gerenciadorTransacoes.emit('transacao_para_recuperar', transacao);
        
        // Verificar que a mensagem foi enviada ao remetente correto
        expect(dependencias.clienteWhatsApp.enviarMensagem).toHaveBeenCalledWith(
          'usuario-recuperacao@c.us',
          'Resposta que deve ser entregue após recuperação',
          expect.objectContaining({ isRecoveredMessage: true })
        );
        
        // Verificar que a transação foi marcada como entregue
        expect(dependencias.gerenciadorTransacoes.marcarComoEntregue).toHaveBeenCalledWith('tx-recuperacao');
      });
      
      test('Não deve recuperar transação com dados insuficientes', async () => {
        // Criar uma transação simulada sem dados suficientes
        const transacaoIncompleta = {
          id: 'tx-incompleta',
          resposta: 'Resposta que nunca será entregue'
          // Sem dadosRecuperacao
        };
        
        // Emitir evento de transação para recuperar
        dependencias.gerenciadorTransacoes.emit('transacao_para_recuperar', transacaoIncompleta);
        
        // Verificar que nenhuma mensagem foi enviada
        expect(dependencias.clienteWhatsApp.enviarMensagem).not.toHaveBeenCalled();
      });
      
      test('Deve lidar com erros durante a recuperação', async () => {
        // Criar uma transação simulada com dados válidos
        const transacao = {
          id: 'tx-erro-recuperacao',
          resposta: 'Resposta que falhará ao enviar',
          dadosRecuperacao: {
            remetenteId: 'fail@c.us', // ID que causará falha no envio
            chatId: 'chat-recuperacao'
          }
        };
        
        // Configurar mock para falhar
        dependencias.clienteWhatsApp.enviarMensagem.mockRejectedValueOnce(new Error('Falha simulada'));
        
        // Emitir evento de transação para recuperar
        dependencias.gerenciadorTransacoes.emit('transacao_para_recuperar', transacao);
        
        // Verificar que o erro foi registrado
        expect(dependencias.registrador.error).toHaveBeenCalled();
      });
    });
    
    describe('Falhas e condições de borda', () => {
      test('Deve lidar com erro no servicoMensagem.enviarResposta', async () => {
        const mensagem = criarMockMensagemTexto('Mensagem normal');
        dependencias.servicoMensagem.enviarResposta.mockRejectedValueOnce(new Error('Erro no envio'));
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
      });
      
      test('Deve lidar com objeto de mensagem malformado', async () => {
        const mensagemInvalida = { 
          // Sem ID
          body: 'Mensagem inválida',
          from: 'sender@c.us'
        };
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagemInvalida);
        
        expect(resultado).toBe(false);
        // Não deve chegar a chamar nenhum processamento
        expect(dependencias.gerenciadorTransacoes.criarTransacao).not.toHaveBeenCalled();
      });
      
      test('Deve lidar com falha ao obter chat', async () => {
        const mensagem = criarMockMensagemTexto('Teste');
        mensagem.getChat.mockRejectedValueOnce(new Error('Chat inacessível'));
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
      });
  
      test('Deve lidar com mensagens de sistema corretamente', async () => {
        // Criar uma mensagem que parece ser de sistema
        const mensagemSistema = criarMockMensagem({
          body: '',
          hasMedia: false,
          type: 'notification',
          _data: { subtype: 'system' }
        });
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagemSistema);
        
        expect(resultado).toBe(false);
        // Não deve processar mensagens de sistema
        expect(dependencias.gerenciadorTransacoes.criarTransacao).not.toHaveBeenCalled();
      });
      
      test('Deve lidar com falha crítica no gerenciadorTransacoes', async () => {
        const mensagem = criarMockMensagemTexto('Mensagem normal');
        dependencias.gerenciadorTransacoes.criarTransacao.mockRejectedValueOnce(new Error('Falha crítica no banco'));
        
        const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
        
        expect(resultado).toBe(false);
        expect(dependencias.registrador.error).toHaveBeenCalled();
      });
    });
    
    describe('Inicialização e Registro', () => {
      test('Deve inicializar corretamente', () => {
        expect(gerenciadorMensagens.iniciar).toBeDefined();
        expect(gerenciadorMensagens.registrarComoHandler).toBeDefined();
        
        // Limpar mocks para garantir chamadas específicas deste teste
        jest.clearAllMocks();
        
        const resultado = gerenciadorMensagens.iniciar();
        
        expect(resultado).toBe(true);
        expect(dependencias.clienteWhatsApp.on).toHaveBeenCalledWith('mensagem', expect.any(Function));
        expect(dependencias.clienteWhatsApp.on).toHaveBeenCalledWith('entrada_grupo', expect.any(Function));
        expect(dependencias.gerenciadorTransacoes.on).toHaveBeenCalledWith('transacao_para_recuperar', expect.any(Function));
      });
      
      test('Deve registrar como handler em um cliente customizado', () => {
        const clienteCustomizado = new EventEmitter();
        clienteCustomizado.on = jest.fn();
        
        const resultado = gerenciadorMensagens.registrarComoHandler(clienteCustomizado);
        
        expect(resultado).toBe(true);
        expect(clienteCustomizado.on).toHaveBeenCalledWith('mensagem', expect.any(Function));
        expect(clienteCustomizado.on).toHaveBeenCalledWith('entrada_grupo', expect.any(Function));
      });
    });
    
    describe('Desempenho e comportamento sob carga', () => {
      test('Deve processar várias mensagens em sequência sem problemas', async () => {
        const mensagens = [
          criarMockMensagemTexto('Mensagem 1'),
          criarMockMensagemTexto('Mensagem 2'),
          criarMockMensagemTexto('Mensagem 3'),
          criarMockMensagemComando('ajuda'),
          criarMockMensagemImagem('Imagem 1')
        ];
        
        // Processar todas as mensagens em sequência
        const resultados = await Promise.all(mensagens.map(m => gerenciadorMensagens.processarMensagem(m)));
        
        // Todas as mensagens devem ser processadas com sucesso
        expect(resultados.every(Boolean)).toBe(true);
        expect(dependencias.gerenciadorTransacoes.criarTransacao).toHaveBeenCalledTimes(4); // 3 textos + 1 imagem
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledTimes(4); // 3 textos + 1 ajuda
        expect(dependencias.filaProcessamentoImagem.add).toHaveBeenCalledTimes(1); // 1 imagem
      });
      
      test('Deve ignorar duplicatas em mensagens em massa', async () => {
        // Criar 5 mensagens com mesmo ID para simular duplicatas
        const id = { _serialized: `duplicado-${Date.now()}` };
        const mensagensDuplicadas = Array(5).fill(0).map(() => 
          criarMockMensagem({ id, body: 'Mensagem duplicada' })
        );
        
        // Processar todas as mensagens em paralelo
        await Promise.all(mensagensDuplicadas.map(m => gerenciadorMensagens.processarMensagem(m)));
        
        // Deve processar apenas uma vez
        expect(dependencias.gerenciadorTransacoes.criarTransacao).toHaveBeenCalledTimes(1);
        expect(dependencias.gerenciadorAI.processarTexto).toHaveBeenCalledTimes(1);
      });
      
      test('Deve responder rapidamente a comandos mesmo sob carga', async () => {
        // Configurar geradorAI para ser lento em processamento normal
        const processarTextoOriginal = dependencias.gerenciadorAI.processarTexto;
        dependencias.gerenciadorAI.processarTexto = jest.fn().mockImplementation(async (texto) => {
          if (!texto.startsWith('.')) {
            // Simulação de processamento lento para textos normais
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return processarTextoOriginal(texto);
        });
        
        // Criar mensagens - um comando e várias mensagens normais
        const comando = criarMockMensagemComando('ajuda');
        const mensagensNormais = Array(5).fill(0).map((_, i) => 
          criarMockMensagemTexto(`Mensagem de carga ${i}`)
        );
        
        // Processar tudo junto, com o comando no meio
        const todasMensagens = [
          ...mensagensNormais.slice(0, 2),
          comando,
          ...mensagensNormais.slice(2)
        ];
        
        // Iniciar processamento de todas as mensagens
        const promessas = todasMensagens.map(m => gerenciadorMensagens.processarMensagem(m));
        
        // Aguardar todas terminarem
        await Promise.all(promessas);
        
        // O comando deve ter sido processado
        expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
          comando,
          expect.stringContaining('comandos'),
          expect.anything()
        );
      });
    });
  });
