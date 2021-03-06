var timestamp = require('console-stamp')(console, '[dd.mm.yyyy HH:MM:ss.l]');
var fs = require('fs')
var assert = require('assert')
var pack = require('./pack')
var auth = require('./chat-packet')
var connect = require('./connect')
var handle = connect.handle
var s = connect.s
var events = require('events')
var Q = require('q')
var parseString = require('xml2js').parseString;
var http = require('http'); // switched to 'request'
var util = require('util')
var express = require('express');
var request = require('request')

// Import Commands
var commands = require('./modules/commands_module.js')
// Define Events
global.outstandingLookups = new events.EventEmitter()

var buddyStatus = new events.EventEmitter()
var privgrp = new events.EventEmitter()

var incMessage = new events.EventEmitter()

var defaultFontColor = '<font color=\'#89D2E8\'>'

var mysql      = require('mysql');
global.pool = mysql.createPool({
  connectionLimit: 6,
  host     : 'localhost',
  database : 'raidbot',
  user     : 'raidbot',
  password : 'raidbot'
});



var LOGIN = ''
var PASS = ''
global.Botname = 'Botname'
var commandPrefix = '.'

function pack_key(key) {
        return pack.pack(
        [
            ['I', 0],
            ['S', LOGIN],
            ['S', key]
        ])
    }

	
	
// RESPONSE HANDLERS //	
	
handle[auth.AOCP.LOGIN_SEED] = function (payload) {
    console.log('LOGIN_SEED')
    var seedLength = payload.readInt16BE(0)
    assert.equal(seedLength, payload.length - 2)
    var seed = payload.slice(2)

    var data = pack_key(auth.generate_login_key(seed, LOGIN, PASS))
    var pp = auth.assemble_packet(auth.AOCP.LOGIN_REQUEST, data)

    s.write(pp)
}
// Select Character
handle[auth.AOCP.LOGIN_CHARLIST] = function (data) {
    console.log('LOGIN_CHARLIST')
    var chars = pack.unpack(data)
    console.log(chars)
    for (var key in chars) {
        if (key.toLowerCase() === Botname.toLowerCase()) {
            console.log(Botname + ' Found')
            var i = Object.keys(chars).indexOf(key)
            global.botId = chars[Object.keys(chars)[i]].id
            break;
        }
    }
    if (!botId) {
        die(Botname + ' was not found on this account')
    }
    console.log({
        botId: botId
    })
    var data = pack.pack([
        ['I', botId]
    ])
    var pp = auth.assemble_packet(auth.AOCP.LOGIN_SELECT, data)
    s.write(pp)
}

handle[auth.AOCP.LOGIN_ERROR] = function (data) {
    pack.unpackError(data)
    die()
}

handle[auth.AOCP.LOGIN_OK] = function () {
    console.log('Logged On')
	connectdb().done(function (connection) {
		query(connection,'DELETE FROM online')
		query(connection,'DELETE FROM channel')
		query(connection,'DELETE FROM uptime')
		query(connection,'DELETE FROM raidforce')
		query(connection,'INSERT INTO uptime (start) VALUES (UNIX_TIMESTAMP(NOW()))')
		connection.release()
	})
}

handle[auth.AOCP.CLIENT_NAME] = function (data, u) {
    var userId = u.I()
    var userName = u.S()
    u.done()
	connectdb().done(function (connection) {
		getUserName(connection,userId).done(function(result) {
			if (result[0].length === 0 || (new Date() / 1000 - result[0][0].lastupdate) > 86400 ) { 
			query(connection,'DELETE FROM players WHERE charId ='+ userId)
			request('http://people.anarchy-online.com/character/bio/d/5/name/' + userName + '/bio.xml', function (error, response, body) {
		if (!error && response.statusCode == 200) {
					if (body.length > 10) { // check if xml is empty
						parseString(body, function (err, result) {
							charName = result.character.name[0]
							charStats = result.character.basic_stats[0]
							charOrg =''
							charOrg.organization_name = 'Not in a guild'
							charOrg.rank = 'None'
							if (result.character.organization_membership !== undefined) { charOrg = result.character.organization_membership[0]
								} else {
									charOrg = {
									organization_name : 'Not in a guild',
									rank : 'None'	
									}
								}	
							charLastUpdated = result.character.last_updated[0]
							
							connection.query('INSERT INTO players (charid, firstname, name, lastname, level, breed, gender, faction, profession, profession_title, ai_rank, ai_level, guild, guild_rank, source, lastupdate) VALUES (' 
								+ userId 
								+ ',"' + charName.firstname + '",' 
								+ '"' + charName.nick + '",' 
								+ '"' + charName.lastname + '",' 
								+ charStats.level + ','
								+ '"' + charStats.breed + '",'
								+ '"' + charStats.gender + '",'
								+ '"' + charStats.faction + '",'
								+ '"' + charStats.profession + '",'
								+ '"' + charStats.profession_title + '",'
								+ '"' + charStats.defender_rank + '",'
								+ charStats.defender_rank_id + ','
								+ '"' + charOrg.organization_name + '",'
								+ '"' + charOrg.rank + '",'
								+ '"people.anarchy-online.com",'
								+ '(UNIX_TIMESTAMP(NOW())))', function(err, result) {
									if(err) {
										console.log(err)
										connection.release()
									}
									connection.release()	
									}
								)	
							})
						} else {
							connection.release()
						}	
					}							
				}).on('error', function(err) {
					console.log('Error while trying to connect to AO People: ' + err)
				})
			} else {
				connection.release()
			}			
		})
	})
}

handle[auth.AOCP.BUDDY_ADD] = function (data, u) { // handles online/offline status too
    var userId = u.I()
    var userStatus = u.I() == 1 ? 'online' : 'offline'
    var unknownPart = u.S()
    u.done()
		
	setTimeout(function(){  
		if (userStatus === 'online') {
			buddyStatus.emit('online', userId, userStatus)
		} else if (userStatus === 'offline') {
			buddyStatus.emit('offline', userId, userStatus)
		}   
	}, 1000)
   
}

handle[auth.AOCP.BUDDY_REMOVE] = function (data, u) {
    console.log('BUDDY_REMOVE')
    var userId = u.I()
    u.done()
    console.log('User with id:' + userId + ' removed')
	buddyStatus.emit('offline', userId)
}

handle[auth.AOCP.MESSAGE_PRIVATE] = function (data, u) {
    var userId = u.I()
    var text = u.S().replace(commandPrefix,'')
    var unknownPart = u.S()
    u.done()
	incMessage.emit('pm', userId, text)
	
}	


handle[auth.AOCP.CLIENT_LOOKUP] = function (data, u) {
    var userId = u.I()
    var userName = u.S()
    u.done()
    var idResult = userId;
    outstandingLookups.emit(userName, idResult)
}

var extHandle = {}

handle[auth.AOCP.GROUP_MESSAGE] = function (data, u)
{
	console.log('GROUP_MESSAGE')

	var ch = u.G()
	var userId = u.I()
	var text = u.E()
	var unknownPart = u.S()
	u.done()
//CH Buffers
//  <Buffer 03 00 00 25 e0> ==> ORG
//  <Buffer 87 07 76 01 10> ==> VICINITY

	var ext = u.extMsg(text)

	if (ext.text)
	{
		console.log({ch : ch, userId : userId, nonExtended : ext.text})
		return
	}


	console.log({from: userId, category : ext.category, instance : ext.instance })
	var cats = {
		//MISC
		'501_ad0ae9b' : 'ORG_LEAVE', // alingment change
		
		// Towers	
		'506_0c299d4' : 'NW_ATTACK',
		'506_8cac524' : 'NW_ABANDON',
		'506_70de9b2' : 'NW_OPENING',
		'506_5a1d609' : 'NW_TOWER_ATT_ORG',
		'506_5a1d68'  : 'NW_TOWER_ATT',
		'506_fd5a1d4' : 'NW_TOWER',
		
		// ORG
		'508_a5849e7' : 'ORG_JOIN',
		'508_2360067' : 'ORG_KICK',
		'508_2bd9377' : 'ORG_LEAVE',
		'508_8487156' : 'ORG_FORM',
		'508_88cc2e7' : 'ORG_DISBAND',
		'508_477095'  : 'ORG_VOTE',
		'508_8241d4'  : 'ORG_ORBITAL_STRIKE',
		
		//CITY
		'1001_01' : 'AI_CLOAK',
		'1001_02' : 'AI_RADAR',
		'1001_03' : 'AI_ATTACK',
		'1001_04' : 'AI_HQ_REMOVE',
		'1001_05' : 'AI_REMOVE_INIT',
		'1001_06' : 'AI_REMOVE',
		'1001_07' : 'AI_HQ_REMOVE_INIT'	
	   
   	} 

	var key = ext.category + '_' + ext.instance

	if (key in cats)
	{
		if (cats[key] in extHandle)
		{
			console.log("extHandle.%s", cats[key])
			extHandle[cats[key]](ext.u)
		}
		else
		{
			console.log("No extHandle.%s", cats[key])
		}
	}
	else
	{
		console.log("Unknown extended message identifier: %s", key)
	}
}

extHandle.ORG_JOIN = function (u) { // Template
    var s1 = u.eS()
    var s2 = u.eS()
    console.log(s1 + ' invited ' + s2 + ' to your organization.' )
}

handle[auth.AOCP.CHAT_NOTICE] = function (data, u) {
    console.log('CHAT_NOTICE')
    var userId = u.I()
    var data2 = u.I() // ?
    var data3 = u.I() // ?
    var text = u.S() 
    u.done()
}

handle[auth.AOCP.PRIVGRP_CLIJOIN] = function (data, u) {
    var botId = u.I()
    var userId = u.I()
    u.done()
	privgrp.emit('join', userId)
    
}

handle[auth.AOCP.PRIVGRP_CLIPART] = function (data, u) {
    var botId = u.I()
    var userId = u.I()
    u.done()
	privgrp.emit('part', userId)
    
}

handle[auth.AOCP.PRIVGRP_PART] = function (data, u) {
    var botId = u.I()
    var userId = u.I()
    u.done()
}

handle[auth.AOCP.PRIVGRP_MESSAGE] = function (data, u) {
    var botId = u.I()
    var userId = u.I()
    var text = u.S()
    var unknownPart = u.S()
    u.done()
	incMessage.emit('grp', userId, text)
	
}

handle[auth.AOCP.PRIVGRP_REFUSE] = function (data, u) // Needs testing
{
    var arg1 = u.I()
    var arg2 = u.I()
    u.done()

}

handle[auth.AOCP_GROUP_ANNOUNCE] = function (data, u) {
    var buffer = u.G()
    var text1 = u.S()
    var digit = u.I()
    var text2 = u.S()
    u.done();
    console.log("Group Announce")
    console.log({
        buffer: buffer,
        text1: text1,
        digit: digit,
        text2: text2
    })



}
// REQUEST HANDLERS //

global.send = function(type, spec) {
    s.write(auth.assemble_packet(type, pack.pack(spec)))
}

global.send_PRIVGRP_MESSAGE = function(chanId, text) {
    send(
    auth.AOCP.PRIVGRP_MESSAGE, [
        ['I', chanId],
        ['S', defaultFontColor + text + '</font>'],
        ['S', '\0']
    ])
}
global.send_MESSAGE_PRIVATE = function(userId, text) {
    console.log('%s -> %d', text, userId)
    send(
    auth.AOCP.MESSAGE_PRIVATE, [
        ['I', userId],
        ['S', defaultFontColor + text + '</font>'],
        ['S', '\0']
    ])
}

global.send_ONLINE_SET = function(arg) {
    console.log('SET ONlINE')
    send(
    auth.AOCP.ONLINE_SET, [
        ['I', arg]
    ])
}

global.send_PRIVGRP_KICK = function(userId) {
    send(
    auth.AOCP.PRIVGRP_KICK, [
        ['I', userId]
    ])
    console.log('Kicked ' + userId + ' from channel')
}

global.send_PRIVGRP_JOIN = function(userId) {
    send(
    auth.AOCP.PRIVGRP_JOIN, [
        ['I', userId]
    ])

}

global.send_PRIVGRP_PART = function(userId) {
    send(
    auth.AOCP.PRIVGRP_PART, [
        ['I', userId]
    ])

}

global.send_PRIVGRP_KICKALL = function() 
{
	send(
		auth.AOCP.PRIVGRP_KICKALL, 	[]
	)
	
}

global.send_CLIENT_LOOKUP = function(userName) {
    send(
    auth.AOCP.CLIENT_LOOKUP, [
        ['S', userName.toString()]
    ])

}

global.send_BUDDY_ADD = function(userId) {
    console.log('BUDDY_ADD_id %d', userId)
    send(
    auth.AOCP.BUDDY_ADD, [
        ['I', userId],
        ['S', '\u0001']
    ])
}

global.send_PRIVGRP_INVITE = function(userId) {
    console.log('Inviting user to chat')
    send(
    auth.AOCP.PRIVGRP_INVITE, [
        ['I', userId]
    ])
}

global.send_BUDDY_REMOVE = function(userId) {
    console.log('BUDDY_REMOVE_id %d', userId)
    send(
    auth.AOCP.BUDDY_REMOVE, [
        ['I', userId]
    ])
}
global.send_GROUP_MESSAGE = function() {
	console.log('send_GROUP_MESSAGE')
	send(
	auth.AOCP.GROUP_MESSAGE, [
		['G', ''], // G = GROUP ID ? ChannelId ? Guild Id
		['S', 'text'],
		['S', 'text2']	
	])
}	
// EVENT HANDLERS //

incMessage.on('pm', function (userId, message) {
	console.log('[PM]' + message)
	connectdb().done(function (connection) {
		query(connection, 'SELECT * FROM uptime').done(function(result) {
			if	((new Date() / 1000 - result[0][0].start) > 5) {
					if (!message.match(/Away from keyboard/ig)) {	// if message is afk reply stop here
						if (cmd.hasOwnProperty(message.split(' ')[0].toLowerCase())) {
							checkAccess(userId).done(function(result) {
								var userAc = result
								query(connection, 'SELECT * FROM cmdcfg WHERE module = "Core" AND cmd = "' + message.split(' ')[0] + '"').done(function(result2) {
									if (result2[0].length === 0 || result2[0].length > 0 && result2[0][0].status === 'enabled' ) {
										if (result2[0].length === 0 || result2[0][0].access_req <= userAc) {
											
											setTimeout(function() {
												if (message.split(' ').length === 1) {
													cmd[message.toLowerCase()](userId)
													connection.release()
												} else {
													var args = []
													for (var i = 1; i < message.split(' ').length; i++) {
														args.push(message.split(' ')[i])
													}
												//console.log(args)
												cmd[message.split(' ')[0].toLowerCase()](userId, args)
												connection.release()
												}
											}, 500)
										} else {	
											send_MESSAGE_PRIVATE(userId, 'Access denied');
											connection.release()
											
										}
								} else { 
								connection.release()
								send_MESSAGE_PRIVATE(userId, 'Command Disabled')
								}
							})
							})
					} else {
						send_MESSAGE_PRIVATE(userId, 'Command not found');
						connection.release()
					}
				}
				
			}	else {
			connection.release()	
			}
		})
		
	})
})	

incMessage.on('grp', function (userId, message) {
    console.log("[Channel]" + userId + ": " + message)
    if (message[0].match(/\!/) && cmd.hasOwnProperty(message.split(' ')[0].replace(commandPrefix, '').toLowerCase())) {
        checkAccess(userId).done(function (result) {
            var userAc = result
            connectdb().done(function (connection) {
                query(connection, 'SELECT * FROM cmdcfg WHERE module = "Core" AND cmd = "' + message.split(' ')[0].replace(commandPrefix, '') + '"').done(function (result2) {
                    if (result2[0].length === 0 || result2[0].length > 0 && result2[0][0].status === 'enabled') {
                        if (result2[0].length === 0 || result2[0][0].access_req <= userAc) {
                            console.log('User acc' + userAc)

                            setTimeout(function () {
                                if (message.split(' ').length === 1) {
                                    cmd[message.replace(commandPrefix, '').toLowerCase()](userId)
                                } else {
                                    var args = []
                                    for (var i = 1; i < message.split(' ').length; i++) {
                                        args.push(message.split(' ')[i])
                                    }
                                    //console.log(args)
                                    cmd[message.split(' ')[0].replace(commandPrefix, '').toLowerCase()](userId, args)
                                }
                            }, 500)
                        } else {
                            send_MESSAGE_PRIVATE(userId, 'Access denied');
                            connection.release()
                        }
                    } else {
                        connection.release()
                        send_MESSAGE_PRIVATE(userId, 'Command Disabled')
                    }
                })
				connection.release()
            })
        })
    } else if (message[0].match(/\!/)) {
        send_MESSAGE_PRIVATE(userId, 'Command not found');
    }
})
//incMessage.on('org' ... to be added
buddyStatus.on('online', function (userId, userStatus) {
    connectdb().done(function(connection) {
		getUserName(connection,userId).done(function(result) {
			query(connection,'INSERT INTO online (charid, name) VALUES (' + userId + ',"' + result[0][0].name + '")').done(function() {
				console.log(result[0][0].name + ' is now online') // send to org channel or group channel
				
			})
		})
		connection.release()
	})
})

buddyStatus.on('offline', function (userId, userStatus) { 
	connectdb().done(function (connection) {
		query(connection,'SELECT * FROM online').done(function(result) {
			if (result[0].length > 0) {
				query(connection,'DELETE FROM online WHERE charid = ' + userId).done(function () {
				console.log(result[0][0].name + ' logged off') // send to org channel or group channel	
				})
			}
				
		})
		connection.release()
	})
})

privgrp.on('join', function(userId) {
	connectdb().done(function(connection) {
		getUserName(connection, userId).done(function(result) {
			query(connection,'INSERT INTO channel (charId,name) VALUES (' + userId + ',"' + result[0][0].name + '")').done(function() {
				send_PRIVGRP_MESSAGE(botId, result[0][0].name + ' joined the channel') 
				
			})
		})
		connection.release()
	})	
})

privgrp.on('part', function(userId) {
	connectdb().done(function(connection) {
		getUserName(connection, userId).done(function(result) {
			query(connection,'DELETE FROM raidforce WHERE name= "' + result[0][0].name + '"').done(function() {
				send_PRIVGRP_MESSAGE(botId, result[0][0].name + ' left the raid') 
			})
			query(connection,'DELETE FROM channel WHERE name= "' + result[0][0].name + '"').done(function() {
				send_PRIVGRP_MESSAGE(botId, result[0][0].name + ' left the channel')
						
			})
		})
		connection.release()
	})	
})	
// CORE STUFF


global.connectdb = function()
{
	 return Q.ninvoke(pool, 'getConnection').fail(function (err, connection)
        {
        console.log(err)
        connection.release()
        })
}
 
global.query = function(connection,sql) {
		return Q.ninvoke(connection, 'query',sql ).fail(function (err, connection)
        {
        console.log(err)
        connection.release()
        })
}	
global.getUserName = function(connection, userId) {
		return Q.ninvoke(connection, 'query','SELECT * FROM players WHERE charid = ' + userId  ).fail(function (err, connection)
        {
        console.log(err)
        connection.release()
        })
}	
global.getUserId = function(connection, userName) {
		return Q.ninvoke(connection, 'query','SELECT * FROM players WHERE name = "' + userName + '"' ).fail(function (err, connection)
        {
        console.log(err)
        connection.release()
        })
}	

	
global.die = function(msg) {
    if (msg) {
        console.log(msg)
    }
    s.removeAllListeners()
    process.exit()
}

global.checkAccess = function(userId) {
        var defer = Q.defer()
        connectdb().done(function (connection) {
            query(connection,'SELECT * FROM admins WHERE charid =' + userId ).done(function(result) {
				if (result[0].length > 0 ) {
                    var access = result[0][0].level
                    defer.resolve(access)
                    return access
                } else {
                    query(connection,'SELECT * FROM members WHERE charid =' + userId).done(function(result) {
                        if (result[0].length > 0 ) {
                            var access = 1 
                            defer.resolve(access)
                            return access
                        } else {
							var access = 0
                            defer.resolve(access)
                            return access
                        }                              
                    })
                }      
            })
			connection.release()
        })
        return defer.promise   
}

// TOOLS

// Blob

global.blob = function (name, content) {
  return '<a href=\'text://'  +  content.replace("'", "`") + '\'>' + name + '</a>'
	
}	

global.tellBlob = function (user, content, link) {
  return '<a href=\"chatcmd:///tell ' + user + ' ' + content.replace("'", "`") + '\">' + link + '</a>'
  
	
}

global.itemref = function (low,high,ql, name) {
	return  "<a href=\"itemref://" + low + "/" + high + "/" + ql + "\">" + name.replace("'", "`") + "</a>"
} 	
