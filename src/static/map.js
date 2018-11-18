var map = L.map('place-map');

L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {attribution: 'Map data © <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'}
).addTo(map);

window.fetch('/place/' + placecode + '/geom').then(function (response) {
  return response.json();
}).then(function(feature) {
  L.geoJson(feature).addTo(map);
  var bbox = feature.geometry.bbox;
  map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
});