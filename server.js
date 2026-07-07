const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

require('dotenv').config();

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 4000;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('ERRO CRÍTICO: DATABASE_URL não configurada!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ==========================================
//           ROTAS DE PAGINAÇÃO (HTML)
// ==========================================

// Redireciona a raiz para o dashboard por padrão
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// ==========================================
//                ROTAS DA API
// ==========================================

// API: Login Administrativo (Valida se o cargo é estritamente 'admin')
app.post('/api/admin/login', async (req, res) => {
  const { usuario, senha } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, usuario, senha, cargo FROM usuarios_acervo WHERE usuario = $1',
      [usuario]
    );

    const user = result.rows[0];

    if (!user || user.senha !== senha) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    if (user.cargo !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
    }

    return res.json({ id: user.id, usuario: user.usuario, cargo: user.cargo });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// API: Dashboard e Gerenciamento - Métricas reais baseadas em 'created_at', 'aprovado' e 'solicitado'
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    // 1. Busca usuários incluindo as colunas 'solicitado' e 'created_at' reais
    const usersRes = await pool.query(
      'SELECT id, created_at, usuario, aprovado, cargo, solicitado FROM usuarios_acervo ORDER BY id DESC'
    );
    
    // 2. Conta os livros de cada usuário na tabela 'acervo_literario' usando o 'id_usuario'
    const booksRes = await pool.query(
      'SELECT id_usuario, COUNT(*) as qtd FROM acervo_literario GROUP BY id_usuario'
    );
    const bookCounts = Object.fromEntries(booksRes.rows.map(r => [r.id_usuario, parseInt(r.qtd) || 0]));

    // 3. Conta quantos livros foram criados pelo usuário no mês atual (Ajustado fuso horário)
    const booksMonthRes = await pool.query(
      "SELECT id_usuario, COUNT(*) as qtd FROM acervo_literario WHERE date_trunc('month', created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') = date_trunc('month', current_date AT TIME ZONE 'America/Sao_Paulo') GROUP BY id_usuario"
    );
    const bookMonthCounts = Object.fromEntries(booksMonthRes.rows.map(r => [r.id_usuario, parseInt(r.qtd) || 0]));
    
    // Concatena todas as informações para enviar ao front-end detalhar
    const usuariosFormatados = usersRes.rows.map(u => ({
      ...u,
      total_livros: bookCounts[u.id] || 0,
      livros_mes: bookMonthCounts[u.id] || 0
    }));

    // 4. Métricas Globais dos Cards (Usando filtros de data reais da Supabase)
    const totalLivrosRes = await pool.query('SELECT COUNT(*) FROM acervo_literario');
    const totalLivros = parseInt(totalLivrosRes.rows[0].count) || 0;

    const totalUsuariosRes = await pool.query('SELECT COUNT(*) FROM usuarios_acervo');
    const totalUsuarios = parseInt(totalUsuariosRes.rows[0].count) || 0;

    // Livros criados no mês atual geral
    const livrosMesRes = await pool.query(
      "SELECT COUNT(*) FROM acervo_literario WHERE date_trunc('month', created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') = date_trunc('month', current_date AT TIME ZONE 'America/Sao_Paulo')"
    );
    const livrosMes = parseInt(livrosMesRes.rows[0].count) || 0;
    
    // Usuários criados no mês atual geral
    const usuariosMesRes = await pool.query(
      "SELECT COUNT(*) FROM usuarios_acervo WHERE date_trunc('month', created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') = date_trunc('month', current_date AT TIME ZONE 'America/Sao_Paulo')"
    );
    const usuariosMes = parseInt(usuariosMesRes.rows[0].count) || 0;

    return res.json({
      usuarios: usuariosFormatados,
      metrics: {
        totalLivros,
        livrosMes,
        totalUsuarios,
        usuariosMes
      }
    });
  } catch (error) {
    console.error('Erro ao processar painel de controle:', error);
    return res.status(500).json({ error: 'Erro interno no servidor do banco.' });
  }
});

// API: Alterar status - Atualiza tanto 'aprovado' quanto 'solicitado' dinamicamente
app.put('/api/admin/usuarios/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { aprovado, solicitado } = req.body; 

    if (aprovado === undefined || solicitado === undefined) {
      return res.status(400).json({ error: 'Os campos "aprovado" e "solicitado" são obrigatórios.' });
    }

    const result = await pool.query(
      'UPDATE usuarios_acervo SET aprovado = $1, solicitado = $2 WHERE id = $3 RETURNING id',
      [Boolean(aprovado), Boolean(solicitado), Number(id) || 0]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não localizado.' });
    }

    return res.json({ success: true, message: 'Status updated successfully.' });
  } catch (error) {
    console.error('Erro ao atualizar status do usuário:', error);
    return res.status(500).json({ error: 'Erro ao processar alteração no banco.' });
  }
});

// ==========================================
//        SISTEMA COMPLETO DE AVISOS
// ==========================================

// API: Buscar todos os avisos cadastrados (histórico geral)
app.get('/api/admin/avisos', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, titulo, aviso, ativo, created_at FROM aviso_acervo ORDER BY id DESC');
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar avisos:', error);
    return res.status(500).json({ error: 'Erro ao buscar histórico de avisos.' });
  }
});

// API: Criar um novo aviso (Desativa os antigos para manter apenas o novo como ativo principal)
app.post('/api/admin/aviso', async (req, res) => {
  try {
    const { titulo, aviso } = req.body;
    if (!titulo || titulo.trim() === "" || !aviso || aviso.trim() === "") {
      return res.status(400).json({ error: 'Título e conteúdo do aviso são obrigatórios.' });
    }

    // Desativa avisos antigos para que apenas o atual fique em destaque na home
    await pool.query('UPDATE aviso_acervo SET ativo = false');

    const result = await pool.query(
      'INSERT INTO aviso_acervo (titulo, aviso, ativo) VALUES ($1, $2, true) RETURNING *',
      [titulo.trim(), aviso.trim()]
    );
    return res.json({ success: true, aviso: result.rows[0] });
  } catch (error) {
    console.error('Erro ao registrar aviso:', error);
    return res.status(500).json({ error: 'Erro interno ao salvar no banco.' });
  }
});

// API: Editar/Atualizar o texto de um aviso existente
app.put('/api/admin/aviso/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, aviso } = req.body;
    if (!titulo || titulo.trim() === "" || !aviso || aviso.trim() === "") {
      return res.status(400).json({ error: 'Título e conteúdo do aviso não podem ser vazios.' });
    }

    const result = await pool.query(
      'UPDATE aviso_acervo SET titulo = $1, aviso = $2 WHERE id = $3 RETURNING id',
      [titulo.trim(), aviso.trim(), Number(id) || 0]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Aviso não localizado.' });
    return res.json({ success: true, message: 'Aviso atualizado com sucesso.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao editar aviso.' });
  }
});

// API: Reenviar / Alternar status Ativo
app.put('/api/admin/aviso/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { ativo } = req.body;

    if (ativo) {
      await pool.query('UPDATE aviso_acervo SET ativo = false');
    }

    const result = await pool.query(
      'UPDATE aviso_acervo SET ativo = $1 WHERE id = $2 RETURNING id',
      [Boolean(ativo), Number(id) || 0]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Aviso não localizado.' });
    return res.json({ success: true, message: 'Status do aviso alterado.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao alterar status do aviso.' });
  }
});

// API: Excluir um aviso definitivamente
app.delete('/api/admin/aviso/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM aviso_acervo WHERE id = $1 RETURNING id', [Number(id) || 0]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Aviso não localizado.' });
    return res.json({ success: true, message: 'Aviso removido com sucesso.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao excluir aviso.' });
  }
});

// Inicialização do Servidor (Sempre no fim do arquivo)
app.listen(port, () => {
  console.log(`[DASHBOARD ENGINE] Sincronizado com tabelas oficiais na porta ${port}`);
});