CREATE TABLE entity_nm_2 (
    col_one BIGINT NOT NULL REFERENCES entity_nm (col_one),
    col_x NUMERIC(1,1) NOT NULL
);
