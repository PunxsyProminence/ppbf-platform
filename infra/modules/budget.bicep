targetScope = 'subscription'

param name string
param amount int
param startDate string
param endDate string
param contactEmails array = []

var notifications = length(contactEmails) == 0
  ? {}
  : {
      Actual80Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: contactEmails
        contactGroups: []
        contactRoles: []
      }
      Forecast100Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: contactEmails
        contactGroups: []
        contactRoles: []
      }
    }

resource budget 'Microsoft.Consumption/budgets@2026-06-01' = {
  name: name
  properties: {
    amount: amount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
      endDate: endDate
    }
    notifications: notifications
  }
}

output name string = budget.name
