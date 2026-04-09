"""
Generate per-entity DDL .sql files for multiple SQL dialects from a Madalier model document.

Public entry point: write_model_ddls(). Dialects and variants are defined by DIALECTS and
DDL_VARIANTS; logical types map to physical SQL in _LOGICAL_TYPES.
"""

from __future__ import annotations

import os
import re
import shutil
from typing import Any

DIALECTS = ('sqlite', 'mysql', 'postgres', 'snowflake', 'mssql', 'databricks')

# full: primary keys + inline FKs from relationships; simple: columns, types, NULL/NOT NULL only
DDL_VARIANTS = ('full', 'simple')

# logical data_type -> dialect -> SQL type (None means DECIMAL with p,s per dialect template)
_LOGICAL_TYPES: dict[str, dict[str, str | None]] = {
    'STRING': {
        'mysql': 'VARCHAR(255)',
        'postgres': 'VARCHAR(255)',
        'sqlite': 'TEXT',
        'mssql': 'NVARCHAR(255)',
        'snowflake': 'VARCHAR(255)',
        'databricks': 'STRING',
    },
    'TEXT': {
        'mysql': 'TEXT',
        'postgres': 'TEXT',
        'sqlite': 'TEXT',
        'mssql': 'NVARCHAR(MAX)',
        'snowflake': 'TEXT',
        'databricks': 'STRING',
    },
    'INTEGER': {
        'mysql': 'INT',
        'postgres': 'INTEGER',
        'sqlite': 'INTEGER',
        'mssql': 'INT',
        'snowflake': 'INTEGER',
        'databricks': 'INT',
    },
    'BIGINT': {
        'mysql': 'BIGINT',
        'postgres': 'BIGINT',
        'sqlite': 'INTEGER',
        'mssql': 'BIGINT',
        'snowflake': 'BIGINT',
        'databricks': 'BIGINT',
    },
    'SMALLINT': {
        'mysql': 'SMALLINT',
        'postgres': 'SMALLINT',
        'sqlite': 'INTEGER',
        'mssql': 'SMALLINT',
        'snowflake': 'SMALLINT',
        'databricks': 'SMALLINT',
    },
    'DECIMAL': {
        'mysql': None,
        'postgres': None,
        'sqlite': None,
        'mssql': None,
        'snowflake': None,
        'databricks': None,
    },
    'FLOAT': {
        'mysql': 'DOUBLE',
        'postgres': 'DOUBLE PRECISION',
        'sqlite': 'REAL',
        'mssql': 'FLOAT',
        'snowflake': 'FLOAT',
        'databricks': 'DOUBLE',
    },
    'BOOLEAN': {
        'mysql': 'TINYINT(1)',
        'postgres': 'BOOLEAN',
        'sqlite': 'INTEGER',
        'mssql': 'BIT',
        'snowflake': 'BOOLEAN',
        'databricks': 'BOOLEAN',
    },
    'DATE': {
        'mysql': 'DATE',
        'postgres': 'DATE',
        'sqlite': 'TEXT',
        'mssql': 'DATE',
        'snowflake': 'DATE',
        'databricks': 'DATE',
    },
    'TIMESTAMP': {
        'mysql': 'DATETIME',
        'postgres': 'TIMESTAMP',
        'sqlite': 'TEXT',
        'mssql': 'DATETIME2',
        'snowflake': 'TIMESTAMP_NTZ',
        'databricks': 'TIMESTAMP',
    },
    'BINARY': {
        'mysql': 'BLOB',
        'postgres': 'BYTEA',
        'sqlite': 'BLOB',
        'mssql': 'VARBINARY(MAX)',
        'snowflake': 'BINARY',
        'databricks': 'BINARY',
    },
}

_DECIMAL_SQL = {
    'mysql': 'DECIMAL({p},{s})',
    'postgres': 'NUMERIC({p},{s})',
    'sqlite': 'REAL',
    'mssql': 'DECIMAL({p},{s})',
    'snowflake': 'NUMBER({p},{s})',
    'databricks': 'DECIMAL({p},{s})',
}


class DdlExportError(Exception):
    """Invalid model for DDL export (e.g. DECIMAL without precision/scale)."""


# Matches app technical names; bare identifiers avoid case-sensitive quoted ids (Snowflake, Postgres, etc.).
_BARE_IDENT_SAFE = re.compile(r'^[a-z][a-z0-9_]*$')

# Dialects where double-quoted identifiers are case-sensitive and tedious in queries — use bare names when safe.
_DIALECTS_BARE_IDENT_WHEN_SAFE = frozenset({'postgres', 'sqlite', 'snowflake', 'databricks'})


def quote_ident(name: str, dialect: str) -> str:
    """Quote identifier for dialect (bare when safe, backticks/brackets/double-quotes otherwise)."""
    if dialect in _DIALECTS_BARE_IDENT_WHEN_SAFE and _BARE_IDENT_SAFE.fullmatch(name):
        return name
    if dialect == 'mysql':
        return '`' + name.replace('`', '``') + '`'
    if dialect == 'mssql':
        return '[' + name.replace(']', ']]') + ']'
    return '"' + name.replace('"', '""') + '"'


def _physical_type_for_attribute(attr: dict[str, Any], dialect: str) -> str:
    """Map model data_type (+ precision/scale for DECIMAL) to dialect-specific SQL type."""
    dt = attr.get('data_type')
    if not isinstance(dt, str):
        raise DdlExportError('attribute missing data_type')
    row = _LOGICAL_TYPES.get(dt)
    if not row:
        raise DdlExportError(f'unknown data_type: {dt!r}')
    spec = row.get(dialect)
    if spec is not None:
        return spec
    # DECIMAL
    p, s = attr.get('precision'), attr.get('scale')
    if not isinstance(p, int) or not isinstance(s, int):
        raise DdlExportError(
            f'DECIMAL attribute {attr.get("technical_name", "?")!r} requires integer precision and scale'
        )
    if p < 1 or s < 0 or s > p:
        raise DdlExportError(
            f'DECIMAL attribute {attr.get("technical_name", "?")!r} has invalid precision/scale'
        )
    tmpl = _DECIMAL_SQL[dialect]
    if '{p}' in tmpl:
        return tmpl.format(p=p, s=s)
    return tmpl


def _ordered_attributes(entity: dict[str, Any]) -> list[dict[str, Any]]:
    attrs = list(entity.get('attributes') or [])
    indexed = list(enumerate(attrs))
    indexed.sort(
        key=lambda i_a: (
            i_a[1].get('attribute_order') if isinstance(i_a[1].get('attribute_order'), int) else (10**9),
            i_a[0],
        )
    )
    return [a for _, a in indexed]


def _build_lookup_maps(model_doc: dict[str, Any]) -> tuple[dict[str, str], dict[str, tuple[str, str]]]:
    """entity_id -> technical_name; attribute_id -> (entity_technical_name, attribute_technical_name)."""
    ent_tn: dict[str, str] = {}
    attr_site: dict[str, tuple[str, str]] = {}
    for ent in model_doc.get('entities') or []:
        eid = ent.get('entity_id')
        etn = ent.get('technical_name')
        if isinstance(eid, str) and isinstance(etn, str):
            ent_tn[eid] = etn
        for a in ent.get('attributes') or []:
            aid = a.get('attribute_id')
            atn = a.get('technical_name')
            if isinstance(aid, str) and isinstance(etn, str) and isinstance(atn, str):
                attr_site[aid] = (etn, atn)
    return ent_tn, attr_site


def _fk_clause(
    entity: dict[str, Any],
    attribute_id: str,
    relationships: list[dict[str, Any]],
    attr_site: dict[str, tuple[str, str]],
    dialect: str,
) -> str:
    eid = entity.get('entity_id')
    for rel in relationships:
        if rel.get('child_entity_id') != eid or rel.get('child_attribute_id') != attribute_id:
            continue
        pa = rel.get('parent_attribute_id')
        if not isinstance(pa, str):
            continue
        site = attr_site.get(pa)
        if not site:
            continue
        parent_table_tn, parent_col_tn = site
        qtbl = quote_ident(parent_table_tn, dialect)
        qcol = quote_ident(parent_col_tn, dialect)
        return f' REFERENCES {qtbl} ({qcol})'
    return ''


def _primary_key_column_names(ordered_attrs: list[dict[str, Any]]) -> list[str]:
    pk = [a for a in ordered_attrs if a.get('key_type') == 'PRIMARY']
    return [a['technical_name'] for a in pk if isinstance(a.get('technical_name'), str)]


def _view_stub_sql(entity_tn: str, dialect: str) -> str:
    q = quote_ident(entity_tn, dialect)
    ph = quote_ident('_madalier_placeholder', dialect)
    lines = [
        f'-- View placeholder: model does not include a SELECT body; replace with your query.',
    ]
    if dialect == 'mysql':
        lines.append(f'CREATE VIEW {q} AS SELECT 1 AS {ph} WHERE 0=1;')
    elif dialect == 'mssql':
        lines.append(f'CREATE VIEW {q} AS SELECT 1 AS {ph} WHERE 1=0;')
    else:
        # postgres, sqlite, snowflake, databricks
        lines.append(f'CREATE VIEW {q} AS SELECT 1 AS {ph} WHERE FALSE;')
    return '\n'.join(lines) + '\n'


def _create_table_sql(
    entity: dict[str, Any],
    model_doc: dict[str, Any],
    dialect: str,
    *,
    full: bool,
) -> str:
    """Build CREATE TABLE DDL; full adds PK and inline FK REFERENCES from relationships."""
    _, attr_site = _build_lookup_maps(model_doc)
    relationships = list(model_doc.get('relationships') or [])
    etn = entity['technical_name']
    qtable = quote_ident(etn, dialect)
    ordered = _ordered_attributes(entity)
    lines = [f'CREATE TABLE {qtable} (']

    if not ordered:
        return (
            f'-- Table {etn}: no attributes defined; add columns before creating a table.\n'
        )

    col_lines: list[str] = []
    pk_cols = _primary_key_column_names(ordered) if full else []

    for a in ordered:
        aname = a.get('technical_name')
        if not isinstance(aname, str):
            continue
        aid = a.get('attribute_id')
        phys = _physical_type_for_attribute(a, dialect)
        parts = [f'    {quote_ident(aname, dialect)} {phys}']
        if a.get('mandatory') is True:
            parts.append('NOT NULL')
        if full and isinstance(aid, str):
            parts.append(_fk_clause(entity, aid, relationships, attr_site, dialect).strip())
        col_lines.append(' '.join(p for p in parts if p))

    if pk_cols:
        qpk = ', '.join(quote_ident(c, dialect) for c in pk_cols)
        col_lines.append(f'    PRIMARY KEY ({qpk})')

    lines.append(',\n'.join(col_lines))
    lines.append(');')
    return '\n'.join(lines) + '\n'


def entity_sql(
    entity: dict[str, Any],
    model_doc: dict[str, Any],
    dialect: str,
    *,
    full: bool = True,
) -> str:
    """DDL for one entity: view stub or CREATE TABLE per dialect and full/simple mode."""
    etype = entity.get('entity_type')
    etn = entity.get('technical_name')
    if not isinstance(etn, str) or not etn.strip():
        raise DdlExportError('entity missing technical_name')
    if etype == 'view':
        return _view_stub_sql(etn, dialect)
    if etype != 'table':
        raise DdlExportError(f'unknown entity_type: {etype!r}')
    return _create_table_sql(entity, model_doc, dialect, full=full)


def write_model_ddls(model_doc: dict[str, Any], base_ddls_dir: str) -> list[str]:
    """
    Write two trees: base_ddls_dir/full/<dialect>/ (keys + FKs) and
    base_ddls_dir/simple/<dialect>/ (columns, types, nullability only).
    Removes any existing base_ddls_dir tree first to drop stale entity files.
    Returns relative paths like data/models/<tn>/ddls/<variant>/<dialect>/<entity>.sql.
    """
    meta = model_doc.get('meta') or {}
    tn = meta.get('technical_name')
    if not isinstance(tn, str) or not tn.strip():
        raise DdlExportError('model meta.technical_name is missing')

    if os.path.isdir(base_ddls_dir):
        shutil.rmtree(base_ddls_dir)

    written: list[str] = []
    entities = list(model_doc.get('entities') or [])

    for variant in DDL_VARIANTS:
        for dialect in DIALECTS:
            ddir = os.path.join(base_ddls_dir, variant, dialect)
            os.makedirs(ddir, exist_ok=True)

    for ent in entities:
        etn = ent.get('technical_name')
        if not isinstance(etn, str) or not re.match(r'^[a-z][a-z0-9_]*$', etn):
            raise DdlExportError(f'invalid entity technical_name: {etn!r}')
        for variant in DDL_VARIANTS:
            full = variant == 'full'
            for dialect in DIALECTS:
                sql = entity_sql(ent, model_doc, dialect, full=full)
                out = os.path.join(base_ddls_dir, variant, dialect, f'{etn}.sql')
                with open(out, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(sql)
                written.append(f'data/models/{tn}/ddls/{variant}/{dialect}/{etn}.sql')

    return written
