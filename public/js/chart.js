$(function () {
    Highcharts.setOptions({
        global: {
            useUTC: false
        }
    })

    var chart = new Highcharts.Chart({
        chart: {
            renderTo: 'container',
            type: 'line',
            zoomType: "x"
        },
        title: {
            text: 'Loading...'
        },
        legend: {
            enabled: false
        },
        xAxis: {
            type: 'datetime'
        },
	yAxis: [{},{}],


        plotOptions: {
            series: {
                lineWidth: 1
            }
        }
    })

    var client = mqtt.connect("ws://kmitchel.ddns.net:9001")

    function receiveMessage(topic, message) {
        chart.series[0].addPoint([Date.now(), Number(message.toString())], true, true)
    }

    updateChart(
        $('.type .selected').attr('data-type'),
        $('.time .selected').attr('data-time'),
        $('.past .selected').attr('data-past'),
        $('.type .selected').attr('data-title'),
        $('.time .selected').attr('data-sub'),
        $('.type .selected').attr('data-unit')
    )

    $('.btnGroup > button').click(function () {
        $(this).addClass('selected').siblings().removeClass('selected')
        updateChart(
            $('.type .selected').attr('data-type'),
            $('.time .selected').attr('data-time'),
            $('.past .selected').attr('data-past'),
            $('.type .selected').attr('data-title'),
            $('.time .selected').attr('data-sub'),
            $('.type .selected').attr('data-unit')
        )
    })

    function updateChart(collection, time, past, title, sub, unit) {
        var url
if (collection == "histogram"){
    client.removeListener("message", receiveMessage)
    client.unsubscribe("power/W")

    $.getJSON("/histogram", function (data) {

        while (chart.series.length > 0) {
            chart.series[0].remove(false)
        }

        chart.setTitle({ text: title }, { text: sub })
        chart.yAxis[0].setTitle({ text: unit })

        data.forEach(function (element) {
            chart.addSeries(element)
        })

        $('.btnGroup').removeClass('hide')

    })

 }else {
        if (collection == "power-W" && time == "00") {
            client.subscribe("power/W")
            client.on("message", receiveMessage)
            chart.yAxis[0].update({
                type: 'logarithmic'
            })
        } else {
            client.removeListener("message", receiveMessage)
            client.unsubscribe("power/W")
            chart.yAxis[0].update({
                type: 'linear'
            })
        }

        if (time == '00') {
            url = '/data/' + collection + "/" + past
        } else {
            url = '/data/' + collection + '/' + time + "/" + past
        }

        $('.btnGroup').addClass('hide')

        $.getJSON(url, function (data) {

            while (chart.series.length > 0) {
                chart.series[0].remove(false)
            }

            chart.setTitle({ text: title }, { text: sub })
            chart.yAxis[0].setTitle({ text: unit })

            data.forEach(function (element) {
                chart.addSeries(element)

let adata = {data:[]}
let bdata = {data:[]}
let cdata = {data:[]}
let ddata = {data:[]}

let am = element.data[0][1]
let bm = am
let cm = am

element.data.forEach(function (e){

  am = am*0.99 + e[1]*0.01
  bm = bm*0.99 + am * 0.01
  cm = cm*0.99 + bm * 0.01

  adata.data.push([e[0],am +  5])
  bdata.data.push([e[0],bm + 10])
  cdata.data.push([e[0],cm + 15])
  ddata.data.push([e[0], 3*am - 3*bm + cm])

})

//chart.addSeries(adata)
//chart.addSeries(bdata)
//chart.addSeries(cdata)
chart.addSeries(ddata)

let der = {yAxis: 1, data:[]}

ddata.data.forEach(function (e,i,a){

if (i>0){

	let t = a[i][0] - a[i-1][0]
	let d = a[i][1] - a[i-1][1]
	//d = d * 100000000
		

	der.data.push([a[i][0],d/t])

}

})

chart.addSeries(der)

            })

            $('.btnGroup').removeClass('hide')

        })

    }


    }

})
