// Fabricated ledger rows for the integration suite.
//
// WHY THIS EXISTS. `fixtureInspection()` used to slice rows out of the operator's
// real historical archive, which meant every ordinary integration test — series
// identity, immutability, privilege separation, concurrency — needed
// INVESTMENT_ARCHIVE_CSV pointing at a private financial record just to obtain
// six well-shaped rows. None of those tests is ABOUT that data; they are about
// publication, constraints and triggers. So the rows are invented here instead.
//
// WHAT IS AND IS NOT INVENTED. Every value below is fabricated: accounts,
// symbols, references, filenames, dates and amounts correspond to nothing. The
// `broker` values are the real platform names because they are approved domain
// vocabulary that the executable mapping in `publish.ts` keys on — an invented
// platform would be rejected by `brokerDirectory()`, so using one would test a
// different code path than production takes.
//
// The real archive is reached from exactly one integration file, the explicitly
// named master-archive suite.

import type { ArchiveRow } from '../../src/types.js'
import { COLUMNS } from '../../src/types.js'

const EMPTY = Object.fromEntries(COLUMNS.map(column => [column, ''])) as ArchiveRow

function row(values: Partial<ArchiveRow>): ArchiveRow {
  return { ...EMPTY, ...values }
}

/**
 * One row per transaction type, in a stable order, so `fixtureInspection(n)`
 * returns the first `n` and remains deterministic.
 */
export const FIXTURE_ROWS: ArchiveRow[] = [
  row({
    trade_date: '2021-01-04', broker: 'Bualuang', account: 'FIX-1001', doc_type: 'confirmation',
    side: 'BUY', asset: 'FIXA', exchange: '', currency: 'THB', units: '100', unit_price: '4.00',
    gross_amount: '400.00', fee: '1.00', vat: '0.07', withholding_tax: '0.00',
    net_amount: '401.07', cash_flow: '-401.07', is_switch: 'false',
    reference: 'FIX-REF-0001', source_file: 'fixture_confirmation_1.txt',
  }),
  row({
    trade_date: '2021-01-05', broker: 'Bualuang', account: 'FIX-1001', doc_type: 'confirmation',
    side: 'SELL', asset: 'FIXA', exchange: '', currency: 'THB', units: '25', unit_price: '5.00',
    gross_amount: '125.00', fee: '0.32', vat: '0.02', withholding_tax: '0.00',
    net_amount: '124.66', cash_flow: '124.66', is_switch: 'false',
    reference: 'FIX-REF-0002', source_file: 'fixture_confirmation_2.txt',
  }),
  row({
    trade_date: '2021-02-01', broker: 'Finnomena', account: 'FIX-2002', doc_type: 'confirmation',
    side: 'SUB', asset: 'FIXFUND-A', exchange: '', currency: 'THB', units: '50', unit_price: '2.00',
    gross_amount: '100.00', fee: '0.00', vat: '0.00', withholding_tax: '0.00',
    net_amount: '100.00', cash_flow: '-100.00', is_switch: 'false',
    reference: 'FIX-REF-0003', source_file: 'fixture_confirmation_3.txt',
  }),
  row({
    trade_date: '2021-03-02', broker: 'Finnomena', account: 'FIX-2002', doc_type: 'confirmation',
    side: 'SWITCH_IN', asset: 'FIXFUND-B', exchange: '', currency: 'THB', units: '30',
    unit_price: '3.00', gross_amount: '90.00', fee: '0.00', vat: '0.00', withholding_tax: '0.00',
    net_amount: '90.00', cash_flow: '-90.00', is_switch: 'true',
    reference: 'FIX-SW-IN-1', source_file: 'fixture_switch_1.txt',
  }),
  row({
    trade_date: '2021-03-01', broker: 'Finnomena', account: 'FIX-2002', doc_type: 'confirmation',
    side: 'SWITCH_OUT', asset: 'FIXFUND-A', exchange: '', currency: 'THB', units: '45',
    unit_price: '2.00', gross_amount: '90.00', fee: '0.00', vat: '0.00', withholding_tax: '0.00',
    net_amount: '90.00', cash_flow: '90.00', is_switch: 'true',
    reference: 'FIX-SW-OUT-1', source_file: 'fixture_switch_1.txt',
  }),
  row({
    trade_date: '2021-04-09', broker: 'Binance TH', account: '', doc_type: 'fee_invoice',
    side: 'FEE', asset: 'FIXFEE', exchange: '', currency: 'THB', units: '', unit_price: '',
    gross_amount: '12.00', fee: '12.00', vat: '0.84', withholding_tax: '0.00',
    net_amount: '12.84', cash_flow: '-12.84', is_switch: 'false',
    reference: 'FIX-REF-0004', source_file: 'fixture_fee_1.txt',
  }),
]

/**
 * A USD row that also carries the broker's own THB equivalent. Publication must
 * record the converted amounts as INFORMATIONAL and never as economic, so a
 * cross-currency total cannot be constructed by accident.
 */
export const DUAL_CURRENCY_ROW: ArchiveRow = row({
  trade_date: '2021-05-10', broker: 'Dime', account: 'FIX-3003', doc_type: 'confirmation',
  side: 'BUY', asset: 'FIXUS', exchange: 'XNAS', currency: 'USD', units: '3', unit_price: '20.00',
  gross_amount: '60.00', fee: '0.10', vat: '0.00', withholding_tax: '0.00',
  net_amount: '60.10', cash_flow: '-60.10',
  gross_thb: '2100.00', fee_thb: '3.50', wht_thb: '0.00', net_thb: '2103.50',
  is_switch: 'false', reference: 'FIX-REF-0005', source_file: 'fixture_confirmation_4.txt',
})

/** A row whose source document omitted the account identifier. */
export const MISSING_ACCOUNT_ROW: ArchiveRow = FIXTURE_ROWS[5]

/** A row whose source document omitted the net amount. */
export const MISSING_NET_ROW: ArchiveRow = row({
  trade_date: '2021-06-21', broker: 'InnovestX', account: 'FIX-4004', doc_type: 'confirmation',
  side: 'BUY', asset: 'FIXB', exchange: '', currency: 'THB', units: '10', unit_price: '7.00',
  gross_amount: '70.00', fee: '0.18', vat: '0.01', withholding_tax: '0.00',
  net_amount: '', cash_flow: '-70.19', is_switch: 'false',
  reference: 'FIX-REF-0006', source_file: 'fixture_confirmation_5.txt',
})

/**
 * The same symbol, same currency, no exchange, held at TWO brokers. Instrument
 * identity must MERGE these rather than splitting on the broker.
 */
export const SAME_SYMBOL_TWO_BROKERS: ArchiveRow[] = [
  row({
    trade_date: '2021-07-01', broker: 'Bualuang', account: 'FIX-1001', doc_type: 'confirmation',
    side: 'BUY', asset: 'FIXSHARED', exchange: '', currency: 'THB', units: '5', unit_price: '10.00',
    gross_amount: '50.00', fee: '0.13', vat: '0.01', withholding_tax: '0.00',
    net_amount: '50.14', cash_flow: '-50.14', is_switch: 'false',
    reference: 'FIX-REF-0007', source_file: 'fixture_confirmation_6.txt',
  }),
  row({
    trade_date: '2021-07-02', broker: 'InnovestX', account: 'FIX-4004', doc_type: 'confirmation',
    side: 'BUY', asset: 'FIXSHARED', exchange: '', currency: 'THB', units: '7', unit_price: '10.00',
    gross_amount: '70.00', fee: '0.18', vat: '0.01', withholding_tax: '0.00',
    net_amount: '70.19', cash_flow: '-70.19', is_switch: 'false',
    reference: 'FIX-REF-0008', source_file: 'fixture_confirmation_7.txt',
  }),
]

/**
 * Three distinct, publishable BUY rows that each carry an account.
 *
 * The out-of-process `--apply` cases write a one-row archive per revision, so
 * they need several rows whose bytes differ; `FIXTURE_ROWS` deliberately holds
 * only one row per transaction type and cannot supply them.
 */
export const PUBLISHABLE_BUY_ROWS: ArchiveRow[] = [
  FIXTURE_ROWS[0],
  SAME_SYMBOL_TWO_BROKERS[0],
  SAME_SYMBOL_TWO_BROKERS[1],
]
