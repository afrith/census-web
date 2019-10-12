import Koa from 'koa'
import Router from 'koa-router'
import winston from 'winston'
import koaLogger from 'koa-logger'
import { Pool, types } from 'pg'
import path from 'path'
import render from 'koa-ejs'
import serve from 'koa-static'
import { groupBy, sumBy, sortBy, reverse } from 'lodash'

types.setTypeParser(20, function(val) {
  return parseInt(val)
})

const app = new Koa();
const router = new Router();

const logger = winston.createLogger({
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
})

app.use(koaLogger(str => logger.info(str)))

const pool = new Pool({connectionString: process.env.DATABASE_URL})

render(app, {
  root: path.join(__dirname, 'views'),
  layout: false,
  viewExt: 'ejs',
  writeResp: false
})

const connectDb = async (ctx, next) => {
  ctx.db = await pool.connect();
  try {
    await next();
  } finally {
    ctx.db.release()
  }
}

const formatInt = (x) => new Number(x).toLocaleString('en-ZA', {
  maximumFractionDigits: 0
})
const formatDec = (x) => new Number(x).toLocaleString('en-ZA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})
const formatPerc = (x) => `${formatDec(x*100)}%`

router.get('/', connectDb, async ctx => {
  const results = await ctx.db.query(
    `SELECT place.code, place.name, place.population, place.area
    FROM census_place place
      JOIN census_placetype pt ON place.placetype_id = pt.id
    WHERE pt.name = 'province'
    ORDER BY place.name`
  )

  ctx.body = await ctx.render('index', {
    provinces: results.rows,
    formatInt, formatDec
  })
})

router.get('/search', async ctx => {
  if (ctx.query.q) {
    ctx.redirect(`/search/${encodeURIComponent(ctx.query.q.trim())}`)
  } else {
    ctx.redirect('/')
  }
})

router.get('/search/:string', connectDb, async ctx => {
  const searchstring = decodeURIComponent(ctx.params.string.replace(/\+/g, ' ')).trim()

  const results = await ctx.db.query(
    `SELECT place.code, place.name, pt.descrip as placetype,
      prov.name as province, place.population, place.area
    FROM census_place place
      JOIN census_placetype pt on place.placetype_id = pt.id
      JOIN census_place prov on place.province_id = prov.id
    WHERE place.name ilike $1
    ORDER BY place.population DESC`,
    [`%${searchstring}%`]
  )

  ctx.body = await ctx.render('search', {
    searchstring,
    results: results.rows,
    formatInt, formatDec
  })
})

const placeQuery = `SELECT p.id, p.code, p.name, pt.descrip AS placetype,
p.population, p.households, p.area
FROM census_place p JOIN census_placetype pt
ON p.placetype_id = pt.id
WHERE p.code = $1::text`

const parentsQuery = `WITH RECURSIVE placetree AS (
  SELECT id, code, name, parent_id, 0 as n
    FROM census_place WHERE code = $1::text
  UNION ALL
  SELECT p.id, p.code, p.name, p.parent_id, n+1
    FROM census_place p JOIN placetree ON p.id = placetree.parent_id
)
SELECT id, code, name FROM placetree
WHERE code != $1::text
ORDER BY n DESC`

router.get('/place/:code', connectDb, async ctx => { 
  const queries = [
    placeQuery, parentsQuery,
    `SELECT
      gc.name as class, g.name as group, pg.value
    FROM census_placegroup pg
      JOIN census_place p ON pg.place_id = p.id
      JOIN census_group g ON pg.group_id = g.id
      JOIN census_groupclass gc ON g.groupclass_id = gc.id
    WHERE p.code = $1::text`,
    `SELECT
      ch.code, ch.name, ch.area, ch.population
    FROM census_place ch
      JOIN census_place pt ON ch.parent_id = pt.id
    WHERE pt.code = $1::text
    ORDER BY UPPER(ch.name)`
  ]

  const results = await Promise.all(queries.map(q => ctx.db.query(q, [ctx.params.code])))

  if (results[0].rows.length == 0) {
    ctx.throw(404)
  }
  const place = results[0].rows[0]

  const parents = results[1].rows

  const pgFlat = results[2].rows.map(r => ({...r, applicable: r.group !== 'Not applicable'}))
  const pgGrp = groupBy(pgFlat, 'class')
  let groups = {}
  for (const theClass in pgGrp) {
    const data = pgGrp[theClass]
    groups[theClass] = {
      total: sumBy(data.filter(x => x.applicable), 'value'),
      notapp: sumBy(data.filter(x => !x.applicable), 'value'),
      groups: reverse(sortBy(data, ['applicable', 'value'])).filter(x => x.value != 0)
    }
  }

  const children = results[3].rows

  ctx.body = await ctx.render('place', {
    place, parents, groups, children,
    formatInt, formatDec, formatPerc
  })
})


router.get('/place/:code/map', connectDb, async ctx => {
  const queries = [placeQuery, parentsQuery]

  const results = await Promise.all(queries.map(q => ctx.db.query(q, [ctx.params.code])))

  if (results[0].rows.length == 0) {
    ctx.throw(404)
  }
  const place = results[0].rows[0]
  const parents = results[1].rows

  ctx.body = await ctx.render('map', {
    place, parents
  })
})

router.get('/place/:code/geom', connectDb, async ctx => {
  const result = await ctx.db.query(
    `SELECT p.id, p.code, p.name, pt.descrip AS placetype,
      ST_AsGeoJSON(geom, 8, 1) as geometry
    FROM census_place p JOIN census_placetype pt
      ON p.placetype_id = pt.id
    WHERE p.code = $1::text`,
    [ctx.params.code]
  )

  if (result.rows.length == 0) {
    ctx.throw(404)
  }

  const row = result.rows[0]
  const feature = {
    type: 'Feature',
    geometry: JSON.parse(row.geometry),
    id: row.code,
    properties: {
      code: row.code,
      name: row.name,
      placetype: row.placetype
    }
  }

  ctx.body = feature
})

router.get('/place/:code/childgeom', connectDb, async ctx => {
  const result = await ctx.db.query(
    `SELECT ch.code, ch.name,
      ST_AsGeoJSON(ch.geom, 8, 1) as geometry
    FROM census_place ch
      JOIN census_place pt ON ch.parent_id = pt.id
    WHERE pt.code = $1::text`,
    [ctx.params.code]
  )

  const features = result.rows.map(row => ({
    type: 'Feature',
    geometry: JSON.parse(row.geometry),
    id: row.code,
    properties: {
      code: row.code,
      name: row.name
    }
  }))

  const collection = {
    type: 'FeatureCollection',
    features
  }

  ctx.body = collection
})

router.get('/place/:code/kml', connectDb, async ctx => {
  const result = await ctx.db.query(
    `SELECT p.id, p.code, p.name, pt.descrip AS placetype,
      ST_AsKML(geom, 10) as kml
    FROM census_place p JOIN census_placetype pt
      ON p.placetype_id = pt.id
    WHERE p.code = $1::text`,
    [ctx.params.code]
  )

  if (result.rows.length == 0) {
    ctx.throw(404)
  }

  const place = result.rows[0]

  ctx.set('Content-Type', 'application/vnd.google-earth.kml+xml')
  ctx.set('Content-Disposition', `attachment; filename=${place.code}.kml`)
  ctx.body = await ctx.render('kml', {place})
})

app.use(router.routes()).use(router.allowedMethods());

app.use(serve(__dirname + '/static'));

const port = process.env.PORT || 3000;
app.listen(port, function (err) {
  if (err) {
    logger.error('Error starting server:', err);
    process.exit(1);
  }

  logger.info('Server listening on port', port);
})