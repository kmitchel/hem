$(function () {
    // Highcharts Dark Theme Configuration
    Highcharts.setOptions({
        global: {
            useUTC: false
        },
        colors: ['#38bdf8', '#818cf8', '#c084fc', '#f472b6', '#fb7185', '#fbbf24', '#34d399'],
        chart: {
            backgroundColor: 'transparent',
            style: {
                fontFamily: 'Inter, sans-serif'
            }
        },
        title: {
            style: {
                color: '#f8fafc',
                fontSize: '18px',
                fontWeight: '600'
            }
        },
        subtitle: {
            style: {
                color: '#94a3b8'
            }
        },
        xAxis: {
            gridLineColor: 'rgba(255, 255, 255, 0.05)',
            labels: {
                style: {
                    color: '#94a3b8'
                }
            },
            lineColor: 'rgba(255, 255, 255, 0.1)',
            minorGridLineColor: 'rgba(255, 255, 255, 0.02)',
            tickColor: 'rgba(255, 255, 255, 0.1)',
            title: {
                style: {
                    color: '#94a3b8'
                }
            }
        },
        yAxis: {
            gridLineColor: 'rgba(255, 255, 255, 0.05)',
            labels: {
                style: {
                    color: '#94a3b8'
                }
            },
            lineColor: 'rgba(255, 255, 255, 0.1)',
            minorGridLineColor: 'rgba(255, 255, 255, 0.02)',
            tickColor: 'rgba(255, 255, 255, 0.1)',
            tickWidth: 1,
            title: {
                style: {
                    color: '#94a3b8'
                }
            }
        },
        legend: {
            itemStyle: {
                color: '#f8fafc'
            },
            itemHoverStyle: {
                color: '#38bdf8'
            },
            itemHiddenStyle: {
                color: '#475569'
            }
        },
        plotOptions: {
            series: {
                marker: {
                    lineColor: '#1e293b'
                }
            },
            line: {
                lineWidth: 2,
                states: {
                    hover: {
                        lineWidth: 3
                    }
                }
            }
        },
        credits: {
            enabled: false
        }
    });

    var chart = new Highcharts.Chart({
        chart: {
            renderTo: 'container',
            type: 'line',
            zoomType: "x"
        },
        title: {
            text: 'Dashboard'
        },
        xAxis: {
            type: 'datetime'
        },
        yAxis: [
            {
                title: { text: '' }
            }
        ],
        plotOptions: {
            series: {
                lineWidth: 2,
                shadow: true
            }
        },
        legend: {
            enabled: true
        }
    });

    var client = mqtt.connect("ws://kmitchel.ddns.net:9001")

    function receiveMessage(topic, message) {
        if (chart.series.length > 0) {
            chart.series[0].addPoint([Date.now(), Number(message.toString())], true, true)
        }
    }

    function updateUI() {
        updateChart(
            $('.type .selected').attr('data-type'),
            $('.time .selected').attr('data-time'),
            $('.past .selected').attr('data-past'),
            $('.type .selected').attr('data-title'),
            $('.time .selected').attr('data-sub'),
            $('.type .selected').attr('data-unit')
        )
    }

    $('.btn-group > button').click(function () {
        $(this).addClass('selected').siblings().removeClass('selected')
        updateUI();
    })

    function updateChart(collection, time, past, title, sub, unit) {
        var url;
        if (collection == "histogram") {
            client.removeListener("message", receiveMessage)
            client.unsubscribe("power/W")

            $.getJSON("/histogram", function (data) {
                while (chart.series.length > 0) {
                    chart.series[0].remove(false)
                }

                chart.setTitle({ text: title }, { text: sub || '' })
                chart.yAxis[0].setTitle({ text: unit })

                data.forEach(function (element) {
                    chart.addSeries(element)
                })
            })
        } else {
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

            // Show loading state if needed
            // chart.showLoading();

            $.getJSON(url, function (data) {
                while (chart.series.length > 0) {
                    chart.series[0].remove(false)
                }

                chart.setTitle({ text: title }, { text: sub || '' })
                chart.yAxis[0].setTitle({ text: unit })

                data.forEach(function (element) {
                    chart.addSeries(element)
                })
                // chart.hideLoading();
            })
        }
    }

    // Initial load
    updateUI();
});
