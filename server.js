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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// API: Dashboard - Puxando métricas reais baseadas em 'created_at', 'aprovado' e 'solicitado'
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

    return res.json({ success: true, message: 'Status atualizado com sucesso.' });
  } catch (error) {
    console.error('Erro ao atualizar status do usuário:', error);
    return res.status(500).json({ error: 'Erro ao processar alteração no banco.' });
  }
});

app.listen(port, () => {
  console.log(`[DASHBOARD ENGINE] Sincronizado com tabelas oficiais na porta ${port}`);
});