var map = L.map('place-map');

var osm = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {attribution: 'Map data © <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'}
);
osm.addTo(map);

var ngi = L.tileLayer(
  'http://{s}.aerial.openstreetmap.org.za/ngi-aerial/{z}/{x}/{y}.jpg',
  {attribution: 'Aerial photo by <a href="http://www.ngi.gov.za/">CD:NGI</a>'}
);

L.control.layers({
  'Map': osm,
  'Satellite': ngi
}).addTo(map);

window.fetch('/place/' + placecode + '/geom').then(function (response) {
  return response.json();
}).then(function(feature) {
  L.geoJson(feature).addTo(map);
  var bbox = feature.geometry.bbox;
  map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);

  return window.fetch('/place/' + placecode + '/childgeom');
}).then(function(response) {
  return response.json()
}).then(function (collections) {
  if (collections.features.length > 0) {
    L.geoJson(collections, {
      style: {
        weight: 1.5,
        fillOpacity: 0
      },
      onEachFeature: function (feature, layer) {
        layer.bindPopup('<a href="/place/' + feature.properties.code + '">' + feature.properties.name + '</a>');
      }
    }).addTo(map);
  }
});