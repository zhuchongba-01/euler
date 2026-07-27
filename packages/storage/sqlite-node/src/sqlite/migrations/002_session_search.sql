CREATE VIRTUAL TABLE IF NOT EXISTS session_entry_search_fts USING fts5(
	search_text,
	content = '',
	tokenize = 'trigram remove_diacritics 1'
);
