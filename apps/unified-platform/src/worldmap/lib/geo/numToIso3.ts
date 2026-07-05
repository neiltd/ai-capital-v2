/**
 * Numeric country ID → ISO 3166-1 alpha-3 lookup table.
 *
 * Source: Natural Earth 110m topology (countries-110m.json).
 * The numeric IDs are UN M.49 codes embedded in the topojson file.
 *
 * This mapping is stable reference data — it does not change unless the
 * base topology file is replaced with a different source.
 *
 * Future: if the topology source changes (e.g. switching to a higher
 * resolution dataset), regenerate this table from the topojson properties
 * rather than maintaining it manually:
 *   node -e "const t=require('./countries-110m.json'); console.log(JSON.stringify(
 *     Object.fromEntries(t.objects.countries.geometries.map(g => [g.id, g.properties.iso_a3]))
 *   ))"
 */
export const NUM_TO_ISO3: Record<string, string> = {
  '004':'AFG','008':'ALB','012':'DZA','024':'AGO','028':'ATG','032':'ARG','036':'AUS',
  '040':'AUT','031':'AZE','044':'BHS','048':'BHR','050':'BGD','052':'BRB','112':'BLR',
  '056':'BEL','084':'BLZ','204':'BEN','064':'BTN','068':'BOL','070':'BIH','072':'BWA',
  '076':'BRA','096':'BRN','100':'BGR','854':'BFA','108':'BDI','116':'KHM','120':'CMR',
  '124':'CAN','132':'CPV','140':'CAF','148':'TCD','152':'CHL','156':'CHN','170':'COL',
  '174':'COM','178':'COG','180':'COD','188':'CRI','384':'CIV','191':'HRV','192':'CUB',
  '196':'CYP','203':'CZE','208':'DNK','262':'DJI','214':'DOM','218':'ECU','818':'EGY',
  '222':'SLV','226':'GNQ','232':'ERI','233':'EST','231':'ETH','242':'FJI','246':'FIN',
  '250':'FRA','266':'GAB','270':'GMB','268':'GEO','276':'DEU','288':'GHA','300':'GRC',
  '308':'GRD','320':'GTM','324':'GIN','624':'GNB','328':'GUY','332':'HTI','340':'HND',
  '348':'HUN','356':'IND','360':'IDN','364':'IRN','368':'IRQ','372':'IRL','376':'ISR',
  '380':'ITA','388':'JAM','392':'JPN','400':'JOR','398':'KAZ','404':'KEN','296':'KIR',
  '408':'PRK','410':'KOR','414':'KWT','417':'KGZ','418':'LAO','422':'LBN','426':'LSO',
  '430':'LBR','434':'LBY','440':'LTU','442':'LUX','450':'MDG','454':'MWI','458':'MYS',
  '462':'MDV','466':'MLI','470':'MLT','478':'MRT','484':'MEX','583':'FSM','498':'MDA',
  '496':'MNG','504':'MAR','508':'MOZ','104':'MMR','516':'NAM','520':'NRU','524':'NPL',
  '528':'NLD','554':'NZL','558':'NIC','562':'NER','566':'NGA','578':'NOR','512':'OMN',
  '586':'PAK','585':'PLW','591':'PAN','598':'PNG','600':'PRY','604':'PER','608':'PHL',
  '616':'POL','620':'PRT','634':'QAT','642':'ROU','643':'RUS','646':'RWA','659':'KNA',
  '662':'LCA','670':'VCT','882':'WSM','678':'STP','682':'SAU','686':'SEN','694':'SLE',
  '706':'SOM','710':'ZAF','724':'ESP','144':'LKA','729':'SDN','740':'SUR','752':'SWE',
  '756':'CHE','760':'SYR','762':'TJK','834':'TZA','764':'THA','626':'TLS','768':'TGO',
  '776':'TON','780':'TTO','788':'TUN','792':'TUR','795':'TKM','798':'TUV','800':'UGA',
  '804':'UKR','784':'ARE','826':'GBR','840':'USA','858':'URY','860':'UZB','548':'VUT',
  '862':'VEN','704':'VNM','887':'YEM','894':'ZMB','716':'ZWE','020':'AND','051':'ARM',
  '352':'ISL','438':'LIE','492':'MCO','807':'MKD','480':'MUS','688':'SRB','703':'SVK',
  '705':'SVN','090':'SLB',
}
