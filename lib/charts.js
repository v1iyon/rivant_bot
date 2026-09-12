// Строим URL картинки графика через бесплатный QuickChart.io — не нужно
// ничего рендерить самим, Telegram может принять photo прямо по ссылке.

function buildUrl(config, width = 640, height = 380) {
  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&width=${width}&height=${height}&backgroundColor=white`;
}

export function barChart(buckets, title, labelKey = "label", valueKey = "avgER") {
  const labels = buckets.map((b) => b[labelKey]);
  const values = buckets.map((b) => Number((b[valueKey] || 0).toFixed(2)));
  return buildUrl({
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Engagement rate, %",
          data: values,
          backgroundColor: "#6366f1",
        },
      ],
    },
    options: {
      plugins: { title: { display: true, text: title } },
      scales: { y: { beginAtZero: true } },
    },
  });
}
