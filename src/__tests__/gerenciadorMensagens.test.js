// src/__tests__/GerenciadorMensagens.test.js

const criarGerenciadorMensagens = require('../adaptadores/whatsapp/GerenciadorMensagensV2');
const { EventEmitter } = require('events');

// Mock das dependências
jest.mock('lodash/fp', () => {
  const original = jest.requireActual('lodash/fp');
  return {
    ...original
  };
});

// Mocks para os serviços dependentes
const criarMockLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  level: 'info'
});

const criarMockClienteWhatsApp = () => {
  const cliente = new EventEmitter();
  cliente.cliente = {
    info: { wid: { _serialized: 'bot-id@c.us' } }
  };
  cliente.deveResponderNoGrupo = jest.fn().mockResolvedValue(true);
  cliente.enviarMensagem = jest.fn().mockResolvedValue(true);
  cliente.obterHistoricoMensagens = jest.fn().mockResolvedValue(['Usuario1: Olá', 'Bot: Como posso ajudar?']);
  return cliente;
};

const criarMockGerenciadorConfig = () => ({
  obterConfig: jest.fn().mockResolvedValue({
    temperature: 0.9,
    topK: 1,
    mediaImage: true,
    mediaAudio: true,
    mediaVideo: true,
    modoDescricao: 'curto'
  }),
  definirConfig: jest.fn().mockResolvedValue(true),
  resetarConfig: jest.fn().mockResolvedValue(true),
  obterPromptSistema: jest.fn().mockResolvedValue({ text: 'Prompt de teste' }),
  listarPromptsSistema: jest.fn().mockResolvedValue([{ name: 'prompt1' }, { name: 'prompt2' }]),
  definirPromptSistema: jest.fn().mockResolvedValue(true),
  definirPromptSistemaAtivo: jest.fn().mockResolvedValue(true),
  limparPromptSistemaAtivo: jest.fn().mockResolvedValue(true),
  excluirPromptSistema: jest.fn().mockResolvedValue(true),
  obterOuCriarUsuario: jest.fn().mockResolvedValue({ id: 'user1', name: 'Usuário Teste', joinedAt: new Date() }),
  obterOuCriarGrupo: jest.fn().mockResolvedValue({ id: 'grupo1', title: 'Grupo Teste' })
});

const criarMockGerenciadorAI = () => ({
  processarTexto: jest.fn().mockResolvedValue('Resposta de IA para texto'),
  processarImagem: jest.fn().mockResolvedValue('Descrição da imagem'),
  processarAudio: jest.fn().mockResolvedValue('Transcrição do áudio'),
  processarVideo: jest.fn().mockResolvedValue('Descrição do vídeo'),
  obterOuCriarModelo: jest.fn().mockReturnValue({
    generateContent: jest.fn().mockResolvedValue({
      response: { text: () => 'Resposta gerada pelo modelo' }
    })
  })
});

const criarMockFilaProcessador = () => ({
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  getFormattedQueueStatus: jest.fn().mockResolvedValue('Status da fila: 0 jobs pendentes'),
  limparFilas: jest.fn().mockResolvedValue({ removidos: 5 }),
  setResultCallback: jest.fn()
});

const criarMockGerenciadorTransacoes = () => {
  const gerenciador = new EventEmitter();
  gerenciador.criarTransacao = jest.fn().mockResolvedValue({ id: 'tx-123', chatId: 'chat-1' });
  gerenciador.adicionarDadosRecuperacao = jest.fn().mockResolvedValue(true);
  gerenciador.marcarComoProcessando = jest.fn().mockResolvedValue(true);
  gerenciador.adicionarRespostaTransacao = jest.fn().mockResolvedValue(true);
  gerenciador.marcarComoEntregue = jest.fn().mockResolvedValue(true);
  gerenciador.registrarFalhaEntrega = jest.fn().mockResolvedValue(true);
  gerenciador.recuperarTransacoesIncompletas = jest.fn().mockResolvedValue(0);
  return gerenciador;
};

const criarMockServicoMensagem = () => ({
  enviarResposta: jest.fn().mockResolvedValue(true),
  capturarSnapshotMensagem: jest.fn().mockResolvedValue({
    id: 'msg-1',
    remetente: { id: 'user-1', nome: 'Usuário Teste' },
    texto: 'Conteúdo da mensagem'
  }),
  gerarTextoContexto: jest.fn().mockReturnValue('Contexto da mensagem'),
  Resultado: {
    sucesso: (dados) => ({ sucesso: true, dados, erro: null }),
    falha: (erro) => ({ sucesso: false, dados: null, erro })
  }
});

// Funções auxiliares para criar mocks de mensagens
const criarMockMensagemTexto = (texto = 'Olá, bot!') => ({
  id: { _serialized: `msg-${Date.now()}` },
  from: 'sender@c.us',
  author: 'sender@c.us',
  body: texto,
  hasMedia: false,
  type: 'chat',
  timestamp: Date.now(),
  reply: jest.fn().mockResolvedValue(true),
  getChat: jest.fn().mockResolvedValue({
    id: { _serialized: 'chat-1' },
    sendSeen: jest.fn().mockResolvedValue(true),
    isGroup: false,
    name: 'Chat de Teste'
  })
});

const criarMockMensagemComando = (comando = 'ajuda') => {
  const msg = criarMockMensagemTexto(`.${comando}`);
  return msg;
};

const criarMockMensagemImagem = () => {
  const msg = criarMockMensagemTexto('Descrição da imagem');
  msg.hasMedia = true;
  msg.type = 'image';
  msg.downloadMedia = jest.fn().mockResolvedValue({
    data: 'base64data',
    mimetype: 'image/jpeg'
  });
  return msg;
};

describe('GerenciadorMensagens', () => {
  let gerenciadorMensagens;
  let dependencias;
  
  beforeEach(() => {
    // Preparar as dependências
    dependencias = {
      registrador: criarMockLogger(),
      clienteWhatsApp: criarMockClienteWhatsApp(),
      gerenciadorConfig: criarMockGerenciadorConfig(),
      gerenciadorAI: criarMockGerenciadorAI(),
      filaProcessamento: criarMockFilaProcessador(),
      filaProcessamentoImagem: criarMockFilaProcessador(),
      gerenciadorTransacoes: criarMockGerenciadorTransacoes(),
      servicoMensagem: criarMockServicoMensagem()
    };
    
    // Criar o gerenciador de mensagens
    gerenciadorMensagens = criarGerenciadorMensagens(dependencias);
    
    // Limpar mocks antes de cada teste
    jest.clearAllMocks();
  });
  
  test('Deve inicializar corretamente', () => {
    expect(gerenciadorMensagens).toBeDefined();
    expect(typeof gerenciadorMensagens.processarMensagem).toBe('function');
    expect(typeof gerenciadorMensagens.iniciar).toBe('function');
    expect(typeof gerenciadorMensagens.registrarComoHandler).toBe('function');
  });
  
  test('Deve processar mensagem de texto corretamente', async () => {
    const mensagem = criarMockMensagemTexto();
    
    const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
    
    expect(resultado).toBe(true);
    expect(dependencias.gerenciadorTransacoes.criarTransacao).toHaveBeenCalled();
    expect(dependencias.gerenciadorAI.processarTexto).toHaveBeenCalled();
    expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalled();
  });
  
  test('Deve processar um comando corretamente', async () => {
    const mensagem = criarMockMensagemComando('ajuda');
    
    const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
    
    expect(resultado).toBe(true);
    expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalled();
    
    // Verificar se o conteúdo da resposta inclui a palavra "comandos"
    expect(dependencias.servicoMensagem.enviarResposta.mock.calls[0][1]).toContain('comandos');
  });
  
  test('Deve processar uma imagem corretamente', async () => {
    const mensagem = criarMockMensagemImagem();
    
    const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
    
    expect(resultado).toBe(true);
    expect(dependencias.gerenciadorTransacoes.criarTransacao).toHaveBeenCalled();
    expect(dependencias.filaProcessamentoImagem.add).toHaveBeenCalledWith(
      'process-image',
      expect.objectContaining({
        chatId: 'chat-1',
        modoDescricao: 'curto'
      }),
      expect.anything()
    );
  });
  
  test('Deve lidar com erros corretamente', async () => {
    const mensagem = criarMockMensagemTexto();
    dependencias.gerenciadorAI.processarTexto.mockRejectedValueOnce(new Error('Erro de IA'));
    
    const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
    
    expect(resultado).toBe(false);
    expect(dependencias.registrador.error).toHaveBeenCalled();
    expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalledWith(
      mensagem,
      expect.stringContaining('erro')
    );
  });
  
  test('Deve executar o comando reset corretamente', async () => {
    const mensagem = criarMockMensagemComando('reset');
    
    const resultado = await gerenciadorMensagens.processarMensagem(mensagem);
    
    expect(resultado).toBe(true);
    expect(dependencias.gerenciadorConfig.resetarConfig).toHaveBeenCalled();
    expect(dependencias.gerenciadorConfig.limparPromptSistemaAtivo).toHaveBeenCalled();
    expect(dependencias.servicoMensagem.enviarResposta).toHaveBeenCalled();
  });
});
