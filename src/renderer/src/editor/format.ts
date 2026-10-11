import { formatDialect, postgresql } from 'sql-formatter'

/** Formats SQL in Slate's house style: upper-case keywords, two-space indent, variables untouched. */
export function formatSql(sql: string): string {
  return formatDialect(sql, {
    dialect: postgresql,
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1,
    // Keep :name and $1 variables as they are.
    paramTypes: { named: [':'], numbered: ['$'] }
  })
}
