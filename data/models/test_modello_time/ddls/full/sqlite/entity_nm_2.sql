CREATE TABLE entity_nm_2 (
    col_one INTEGER NOT NULL REFERENCES entity_nm (col_one),
    col_x REAL NOT NULL
);
